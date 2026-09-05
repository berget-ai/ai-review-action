# Sovereign AI Code Review — GitHub Action

AI code review that keeps your code in Europe. Reviews run on [Berget AI](https://berget.ai)'s own GPU infrastructure in Sweden — no code or diffs are ever sent to US cloud providers.

- **Inline findings** posted as line comments on the PR diff, with a structured summary
- **Optional AI approval** — the bot can APPROVE or REQUEST_CHANGES like a human reviewer (with your own GitHub App, [see below](#optional-let-the-bot-approve-or-request-changes))
- **Open weight models** (GLM, Kimi, Qwen, Gemma…) running on EU-sovereign infrastructure
- **Free tier** — [create an API key](https://console.berget.ai) and try it on your first PR in ~5 minutes

## Quick start (5 minutes)

### 1. Get a free API key

Sign up at [console.berget.ai](https://console.berget.ai) and create an API key. The free tier is enough to try code review on real PRs.

### 2. Add it as a repository secret

**Settings → Secrets and variables → Actions → New repository secret**:

- **Name:** `BERGET_API_KEY`
- **Value:** your API key

### 3. Add the workflow

```yaml
# .github/workflows/ai-review.yml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write
  issues: write

concurrency:
  group: ai-review-${{ github.event.pull_request.number || github.event.issue.number || github.run_id }}
  cancel-in-progress: true

jobs:
  review:
    name: AI Review
    runs-on: ubuntu-latest
    if: |
      github.event_name == 'pull_request' ||
      github.event_name == 'workflow_dispatch' ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       contains(github.event.comment.body, '@berget review') &&
       contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'),
                github.event.comment.author_association))
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: >-
            ${{
              github.event.pull_request.head.sha ||
              (github.event.issue.pull_request && format('refs/pull/{0}/merge', github.event.issue.number)) ||
              github.sha
            }}
      - uses: berget-ai/ai-review-action@v1
        with:
          api_key: ${{ secrets.BERGET_API_KEY }}
          use_dora: 'false'
```

Open a PR — the review appears within a couple of minutes. Re-run any time by commenting `@berget review` on the PR.

### Follow-up reviews are incremental

The first review on a PR is a full review. Every posted review carries a hidden marker with the head SHA it covered, so when new commits are pushed the next review is a **follow-up** that:

- diffs only what changed since the previous review,
- verifies whether each previous finding is fixed, still present, or partially fixed,
- flags only new problems — instead of re-posting the whole summary.

Comment `@berget review <what to look at>` to force a full re-review with a specific focus. If the branch was rebased (previous head no longer in history), the action falls back to a full review automatically.

> **Fork pull requests:** GitHub does not expose repository secrets to fork PRs, so the action skips them gracefully. Reviews run as soon as the PR is opened from a branch in your repo.

## Data & privacy

- The PR diff and file contents needed for context are sent to `https://api.berget.ai/v1` over TLS and processed on Berget AI's own GPU servers in Sweden.
- Nothing is used for model training, and no code is sent to third-party LLM providers.
- Your API key is only consumed inside your own GitHub Actions runs — it is never shared.

### Optional: Let the bot approve or request changes

By default the bot posts findings as **comments** and never blocks a PR (GitHub does not allow `github-actions[bot]` to approve). To get real APPROVE / REQUEST_CHANGES reviews that count toward required approvals:

1. **Create a GitHub App** in your org: *Settings → Developer settings → GitHub Apps → New GitHub App*
   - Webhook: **uncheck Active**
   - Repository permissions: **Contents: Read-only**, **Issues: Read & write**, **Pull requests: Read & write**
   - *Only on this account*
2. **Generate a private key** and install the app on your repos.
3. Add two secrets: `AI_REVIEW_APP_ID` (shown on the app's page) and `AI_REVIEW_APP_PRIVATE_KEY` (the downloaded PEM).
4. Pass them to the action:

```yaml
      - uses: berget-ai/ai-review-action@v1
        with:
          api_key: ${{ secrets.BERGET_API_KEY }}
          use_dora: 'false'
          approve: 'true'
          github_app_id: ${{ secrets.AI_REVIEW_APP_ID }}
          github_app_private_key: ${{ secrets.AI_REVIEW_APP_PRIVATE_KEY }}
```

With `approve: 'true'`, a review with no **blocker** findings is posted as APPROVE; a review containing at least one blocker is posted as REQUEST_CHANGES.

> **Note on required approvals:** GitHub may not count approvals from a GitHub App toward a *required approving review count* in branch rulesets (apps are not repository collaborators). The APPROVE review is still posted and visible as a green approval — whether it satisfies merge gating depends on your ruleset configuration.

---

## All the ways to trigger it

Mention `@berget` anywhere on GitHub to trigger a response:

| Where | Trigger | What happens |
|---|---|---|
| Pull request | _(automatic)_ | Structured code review posted on the PR |
| PR comment | `@berget review` | Structured code review posted on the PR |
| PR file comment | `@berget <question>` | Reads the file in context, replies in the thread |
| Issue | `@berget <question>` | Explores the codebase, replies in the issue |
| Discussion | `@berget <question>` | Explores the codebase, replies in the discussion |

Only repository owners, members, and collaborators can trigger the action.

## More setup options

### Chat-style workflow (issues, discussions, inline questions)

For answering `@berget` mentions in issues, PR threads and discussions (not just PR reviews), add this second workflow file:

```yaml
# .github/workflows/berget.yml
name: Berget AI
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, edited]
  discussion:
    types: [created, edited]
  discussion_comment:
    types: [created]

jobs:
  berget:
    if: |
      (contains(github.event.comment.body, '@berget') &&
       contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'),
                github.event.comment.author_association)) ||
      (contains(github.event.issue.body, '@berget') &&
       contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'),
                github.event.issue.author_association)) ||
      (contains(github.event.discussion.body, '@berget') &&
       contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'),
                github.event.discussion.author_association))
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
      discussions: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: >-
            ${{
              github.event.pull_request.head.sha ||
              (github.event.issue.pull_request && format('refs/pull/{0}/merge', github.event.issue.number)) ||
              github.sha
            }}

      - uses: berget-ai/ai-review-action@v1
        with:
          api_key: ${{ secrets.BERGET_API_KEY }}
          # Optionally specify a different Berget model:
          # model: 'berget/zai-org/GLM-5.3-Flash'
```

The action uses the Berget API (`https://api.berget.ai/v1`) by default. No extra configuration is needed.

#### Alternative: pi auth.json

If you prefer to use a local pi OAuth session instead of an API key:

```bash
base64 -i ~/.pi/agent/auth.json | pbcopy
```

Add as `PI_AUTH` secret and use `pi_auth: ${{ secrets.PI_AUTH }}` in the workflow.

## Usage

### PR review

Comment on any PR:

```
@berget review
```

With additional context:

```
@berget review focus on error handling and edge cases
```

### Inline file comment

On the Files Changed tab of a PR, leave a comment on any line:

```
@berget is this safe to call concurrently?
```

```
@berget what happens if this returns null?
```

The agent reads the full file for context before responding.

### Issue

Mention `@berget` anywhere in an issue body when opening it, or in a follow-up comment:

```
We need to migrate the storage layer to D1.

@berget can you map out what currently exists and what would need to change?
```

The agent explores the codebase and posts a grounded reply.

### Discussion

Mention `@berget` in a discussion body or reply:

```
Thinking about moving all rendering to the edge.

@berget what parts of the codebase would be hardest to migrate and why?
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `api_key` | -- | API key for the model provider (e.g. your `BERGET_API_KEY`). Preferred over `pi_auth`. |
| `pi_auth` | -- | Base64-encoded pi `auth.json`. Fallback when `api_key` is not set. |
| `model` | `berget/zai-org/GLM-5.3-Flash` | Model in `provider/model-id` format. |
| `pi_model` | -- | Deprecated alias for `model`. |
| `approve` | `false` | When `true`, post APPROVE (no blockers) or REQUEST_CHANGES (any blocker) instead of COMMENT. Requires a GitHub App — see above. |
| `github_app_id` | -- | GitHub App ID. With `github_app_private_key`, reviews are posted as the app instead of `github-actions[bot]`. |
| `github_app_private_key` | -- | GitHub App private key (PEM). Store as a secret. |
| `github_app_installation_id` | -- | GitHub App installation ID. Optional — auto-resolved from the repo. |
| `provider_base_url` | `https://api.berget.ai/v1` | Base URL for the LLM provider API. Override to use a different endpoint. |
| `provider_name` | `berget` | Provider name registered in `models.json`. Must match the prefix in `model`. |
| `use_dora` | `true` | Enable dora code intelligence. |
| `dora_version` | `latest` | Dora CLI version tag. |
| `scip_install` | `bun install -g @sourcegraph/scip-typescript` | SCIP indexer install command. Set to empty string to skip. |
| `dora_pre_index` | -- | Commands to run after `dora init` but before indexing (e.g. install project deps). |
| `dora_index_command` | `dora index` | Override the dora index command. |
| `project_lockfile` | -- | Path to your project lockfile (e.g. `pnpm-lock.yaml`). When set, `node_modules` is cached across runs. |
| `system_prompt` | -- | Path to a custom system prompt for PR reviews (relative to repo root). |
| `review_template` | -- | Path to a custom review output template (relative to repo root). |
| `extra_prompt` | -- | Additional instructions appended to every review prompt. |
| `obsidian_vault_repo` | -- | GitHub repo containing an Obsidian vault (e.g., `owner/repo`). |
| `obsidian_vault_name` | -- | Vault name for `obi --vault` flag (defaults to repo name). |
| `obsidian_token` | -- | GitHub token for private vault repos (defaults to `GITHUB_TOKEN`). |
| `obsidian_prompt` | -- | Additional instructions for using the obsidian vault via `obi` CLI. |
| `exa_api_key` | -- | Exa AI API key for web search via the `exa_search` tool. |
| `auto_discover_skills` | `false` | Discover and load skills from `.agents/skills/` and `.pi/skills/` in the repo. Default false — only manually loaded skills (dora, obi) are used. |

Either `api_key` or `pi_auth` must be provided. When both are set, `api_key` takes precedence.

## Examples

### Monorepo with pnpm

```yaml
- uses: berget-ai/ai-review-action@v1
  with:
    api_key: ${{ secrets.BERGET_API_KEY }}
    project_lockfile: 'pnpm-lock.yaml'
    dora_pre_index: 'pnpm install --frozen-lockfile'
```

### Large codebase (increase Node heap for dora indexing)

```yaml
- uses: berget-ai/ai-review-action@v1
  with:
    api_key: ${{ secrets.BERGET_API_KEY }}
    dora_index_command: 'NODE_OPTIONS="--max-old-space-size=6144" dora index'
```

### Rust project

```yaml
- uses: berget-ai/ai-review-action@v1
  with:
    api_key: ${{ secrets.BERGET_API_KEY }}
    scip_install: 'cargo install rust-analyzer'
```

### Python project

```yaml
- uses: berget-ai/ai-review-action@v1
  with:
    api_key: ${{ secrets.BERGET_API_KEY }}
    scip_install: 'pip install scip-python'
    dora_pre_index: 'pip install -e .'
```

### Without dora

Uses pre-collected diff context, `grep`, `find`, and direct file reading only. Faster setup, no indexing.

```yaml
- uses: berget-ai/ai-review-action@v1
  with:
    api_key: ${{ secrets.BERGET_API_KEY }}
    use_dora: 'false'
```

### With Obsidian vault

Connect an Obsidian vault from another repo to give the agent access to documentation and architecture notes.

**Setup:**
1. Create a GitHub Personal Access Token with `contents:read` scope for your vault repo
2. Add it as a repository secret (e.g., `OBSIDIAN_TOKEN`) in the repo where the action runs

**Usage:**
```yaml
- uses: berget-ai/ai-review-action@v1
  with:
    api_key: ${{ secrets.BERGET_API_KEY }}
    obsidian_vault_repo: 'myorg/documentation'
    obsidian_vault_name: 'Docs'  # optional, defaults to repo name
    obsidian_token: ${{ secrets.OBSIDIAN_TOKEN }}  # required for private vaults
    obsidian_prompt: |
      Before making architectural decisions, check the vault for documented patterns.
      Search for relevant docs using `obi search` and read the full notes.
```

The agent can use the `obi` CLI to query the vault:
- `obi map --vault "VaultName"` - see vault structure
- `obi read "path/to/note.md" --vault "VaultName"` - read specific notes
- `obi search "term" --vault "VaultName"` - search content
- `obi query --type worker --vault "VaultName"` - filter by frontmatter type

### With extensions (exa-search, etc.)

Extensions add custom tools to the agent. The action supports any pi-compatible extension.

**Available extensions from [pi-kit](https://github.com/butttons/pi-kit):**

| Extension | Tool | Description | Required Secret |
|-----------|------|-------------|-----------------|
| `exa-search` | `exa_search` | Web search via Exa AI | `EXA_API_KEY` |

**Setup:**

1. Add the extension's API key as a GitHub secret (e.g., `EXA_API_KEY` for exa-search)
2. Configure your workflow to clone the extensions and create a pi settings file:

```yaml
- name: Setup pi extensions
  shell: bash
  run: |
    mkdir -p "$HOME/.pi/agent/git/github.com/butttons"
    git clone --depth 1 "https://github.com/butttons/pi-kit.git" "$HOME/.pi/agent/git/github.com/butttons/pi-kit"
    cat > "$HOME/.pi/agent/settings.json" << 'EOF'
    {
      "packages": [
        {
          "source": "git:github.com/butttons/pi-kit"
        }
      ]
    }
    EOF

- uses: berget-ai/ai-review-action@v1
  with:
    api_key: ${{ secrets.BERGET_API_KEY }}
    exa_api_key: ${{ secrets.EXA_API_KEY }}
```

**Usage in prompts:**

Once configured, the agent can use extension tools:

```
@berget search for the latest React best practices and compare them to our codebase
```

```
@berget use exa_search to find documentation for the error handling pattern we're using
```

**Caching:** Extensions are cached by commit SHA for fast warm runs.

### Different model

```yaml
- uses: berget-ai/ai-review-action@v1
  with:
    api_key: ${{ secrets.BERGET_API_KEY }}
    model: 'berget/zai-org/GLM-5.3-Flash'
```

To use a completely different provider, you can also override the base URL and provider name:

```yaml
- uses: berget-ai/ai-review-action@v1
  with:
    api_key: ${{ secrets.ANTHROPIC_KEY }}
    provider_base_url: 'https://api.anthropic.com/v1'
    provider_name: 'anthropic'
    model: 'anthropic/claude-sonnet-4'
```

## Customizing prompts

### PR review

The system prompt and output template for PR reviews are fully replaceable. Defaults are in [`prompts/`](./prompts/):

- [`prompts/system-dora.md`](./prompts/system-dora.md) -- used when dora is enabled
- [`prompts/system-git.md`](./prompts/system-git.md) -- used when dora is disabled
- [`prompts/review-template.md`](./prompts/review-template.md) -- output structure

Point the inputs to your own files:

```yaml
- uses: berget-ai/ai-review-action@v1
  with:
    api_key: ${{ secrets.BERGET_API_KEY }}
    system_prompt: '.github/review-prompt.md'
    review_template: '.github/review-template.md'
```

Use `{base_branch}` in your system prompt -- it gets replaced with the PR's target branch (e.g. `main`).

### Inline comments, issues, discussions

Drop a markdown file in `.pi/prompts/` in your repo to override the default system prompt for each handler:

| File | Overrides |
|---|---|
| `.pi/prompts/inline-comment.md` | Inline PR file comment handler |
| `.pi/prompts/issue.md` | Issue handler |
| `.pi/prompts/discussion.md` | Discussion handler |

## Caching

The action caches the following automatically:

| What | Cache key |
|---|---|
| Bun binary | Managed by `setup-bun` |
| Action `node_modules` | Hash of `bun.lock` |
| dora + scip globals (`~/.bun`) | dora version + scip install command |
| Dora index (`.dora/`) | Commit SHA -- busted on every new commit |
| Project `node_modules` | Hash of `project_lockfile` -- only when `project_lockfile` is set |
| Obsidian vault (`/home/runner/obi-vaults/{vault-name}/`) | Vault repo + commit SHA |
| pi-kit extensions (`~/.pi/agent/git/github.com/butttons/pi-kit`) | pi-kit commit SHA |

On a warm run (same commit, same deps), only the dora agent itself runs -- all installs and indexing are skipped.

## How it works

1. When `github_app_id` + `github_app_private_key` are provided, the action mints a GitHub App installation token (RS256 JWT, no external dependencies) and uses it for all GitHub API calls — this is what enables APPROVE / REQUEST_CHANGES. Otherwise `GITHUB_TOKEN` is used and reviews are posted as comments by `github-actions[bot]`.
2. Validates the commenter is a repo owner, member, or collaborator.
3. Routes based on the GitHub event:
   - `pull_request` → automatic review on every PR
   - `issue_comment` on a PR → `@berget review` triggers a full review
   - `pull_request_review_comment` → reads the file, replies to the thread
   - `issues` / `issue_comment` on a plain issue → explores codebase, replies in the issue
   - `discussion` / `discussion_comment` → explores codebase, replies in the discussion
4. If dora is enabled: installs dora + SCIP indexer (cached), runs `dora init` + `dora index` (cached per commit).
5. Loads extensions from `~/.pi/agent/settings.json` if configured (cached by commit SHA). Skills from `.agents/skills/` are **not** loaded by default — set `auto_discover_skills: 'true'` to include them.
6. Pre-collects the diff, changed file contents, and branch status (behind base, conflict files) into the user prompt so the agent starts with full context.
7. Runs the pi agent with `read`, `bash`, and `web_crawl` tools. Tools are used to **supplement** the pre-collected context — trace references, read sibling/test files, verify external docs — not to rebuild it.
8. Extracts inline findings from the `ai-review-findings` JSON block in the agent's response and posts them as line comments via `pulls.createReview`. Falls back to an issue comment when no findings are present.
9. Posts the response via the appropriate GitHub API (REST for PRs/issues, GraphQL for discussions).

## Requirements

- GitHub Actions runner: `ubuntu-latest` (or any runner with network access to `api.berget.ai`)
- A [Berget AI](https://console.berget.ai) API key (free tier available) — or a base64-encoded pi `auth.json`

## License

MIT
