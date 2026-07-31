import * as core from '@actions/core';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createReadTool,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type Skill,
  type ResourceDiagnostic,
} from '@earendil-works/pi-coding-agent';
import type { BaseConfig } from './types.js';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly isBilling: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

type RunAgentParams = {
  config: BaseConfig;
  systemPrompt: string;
  userPrompt: string;
  skills?: Skill[];
};

function parseModelString({ model }: { model: string }): [string, string] {
  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) {
    return ['anthropic', model];
  }
  return [model.slice(0, slashIndex), model.slice(slashIndex + 1)];
}

function formatArgs({ args }: { args: Record<string, unknown> }): string {
  if ('command' in args && typeof args.command === 'string') return args.command;
  if ('path' in args && typeof args.path === 'string') return args.path;
  return JSON.stringify(args);
}

function extractToolResultText({ result }: { result: unknown }): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    return r.content
      .filter((c: Record<string, unknown>) => c.type === 'text' && typeof c.text === 'string')
      .map((c: Record<string, unknown>) => c.text as string)
      .join('\n');
  }
  return JSON.stringify(result);
}

function extractFinalResponse({ messages }: { messages: readonly unknown[] }): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown[] } | undefined;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const textParts = (msg.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string);

    if (textParts.length > 0) return textParts.join('\n');
  }

  core.warning('No assistant text found in session messages');
  return '';
}

export function loadDoraSkill({ workingDir }: { workingDir: string }): Skill | null {
  const skillPath = join(workingDir, '.dora', 'docs', 'SKILL.md');
  if (!existsSync(skillPath)) {
    core.warning('Dora SKILL.md not found -- agent will proceed without dora skill guidance');
    return null;
  }
  return {
    name: 'dora',
    description:
      'Query codebase using dora CLI for code intelligence, symbol definitions, dependencies, and architectural analysis',
    filePath: skillPath,
    baseDir: join(workingDir, '.dora', 'docs'),
    sourceInfo: {
      path: skillPath,
      source: 'action',
      scope: 'project',
      origin: 'top-level',
      baseDir: join(workingDir, '.dora', 'docs'),
    },
    disableModelInvocation: false,
  };
}

export function loadObiSkill({ actionPath }: { actionPath: string }): Skill | null {
  const skillPath = join(actionPath, 'skills', 'obi', 'SKILL.md');
  if (!existsSync(skillPath)) {
    core.warning('Obi SKILL.md not found -- agent will proceed without obi skill guidance');
    return null;
  }
  return {
    name: 'obi',
    description:
      'Query Obsidian vaults via obi CLI for documentation, architecture notes, and project conventions',
    filePath: skillPath,
    baseDir: join(actionPath, 'skills', 'obi'),
    sourceInfo: {
      path: skillPath,
      source: 'action',
      scope: 'project',
      origin: 'top-level',
      baseDir: join(actionPath, 'skills', 'obi'),
    },
    disableModelInvocation: false,
  };
}

export async function runAgent({
  config,
  systemPrompt,
  userPrompt,
  skills = [],
}: RunAgentParams): Promise<string> {
  const [providerName, modelId] = parseModelString({ model: config.model });
  core.info(`Using model: ${providerName}/${modelId}`);

  const authStorage = config.apiKey
    ? AuthStorage.inMemory({ [providerName]: { type: 'api_key', key: config.apiKey } })
    : AuthStorage.create();

  // Use ModelRegistry.create() (not inMemory) so it reads ~/.pi/agent/models.json
  // and picks up custom providers like Berget AI.
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = modelRegistry.find(providerName, modelId);
  if (!model) throw new Error(`Model not found: ${providerName}/${modelId}. Ensure ~/.pi/agent/models.json is configured with this provider, or use --list-models to see available models.`);

  const agentDir = getAgentDir();
  core.info(`Agent directory: ${agentDir}`);

  // Use SettingsManager.create to read from ~/.pi/agent/settings.json
  const settingsManager = SettingsManager.create(config.workingDir, agentDir);

  // Load manually loaded skills (dora, obi); optionally merge auto-discovered
  // skills from .agents/skills/ and .pi/skills/ in the working directory.
  // By default the auto-discovered set is dropped — it bloats the system
  // prompt and turns reviews into no-ops on repos that ship large agent
  // skill trees (see MCP-181). Set config.autoDiscoverSkills to keep them.
  const skillsOverride = (result: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    const base = config.autoDiscoverSkills ? result.skills : [];
    const mergedSkills = [...base, ...skills];
    core.info(
      `Skills: ${base.length} auto-discovered, ${skills.length} manual, ${mergedSkills.length} total`,
    );
    if (!config.autoDiscoverSkills && result.skills.length > 0) {
      core.info(
        `Ignoring ${result.skills.length} auto-discovered skills (auto_discover_skills=false)`,
      );
    }
    return { skills: mergedSkills, diagnostics: result.diagnostics };
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: config.workingDir,
    agentDir,
    settingsManager,
    systemPrompt,
    skillsOverride,
  });
  await resourceLoader.reload();

  // Check loaded extensions
  const extensionsResult = resourceLoader.getExtensions();
  if (extensionsResult.extensions.length > 0) {
    core.info(`Loaded ${extensionsResult.extensions.length} extensions:`);
    for (const ext of extensionsResult.extensions) {
      core.info(`  - ${ext.path} (${ext.tools.size} tools)`);
      for (const toolName of ext.tools.keys()) {
        core.info(`      * ${toolName}`);
      }
    }
  } else {
    core.info('No extensions loaded');
  }
  if (extensionsResult.errors.length > 0) {
    core.warning(`Extension errors: ${extensionsResult.errors.map(e => e.error).join(', ')}`);
  }

  // Log all skills (manual + packages)
  const allSkills = resourceLoader.getSkills().skills;
  if (allSkills.length > 0) {
    core.info(`Total skills available: ${allSkills.length}`);
    for (const skill of allSkills) {
      core.info(`  - ${skill.name}: ${skill.description.slice(0, 80)}...`);
    }
  }

  const { session } = await createAgentSession({
    cwd: config.workingDir,
    model,
    thinkingLevel: 'medium',
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: ['read', 'bash', 'web_crawl'],
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  session.subscribe((event) => {
    switch (event.type) {
      case 'turn_start':
        core.info('--- Turn started ---');
        break;
      case 'tool_execution_start':
        core.startGroup(`Tool: ${event.toolName}`);
        if (event.toolName === 'bash') core.info(`Command: ${formatArgs({ args: event.args })}`);
        else if (event.toolName === 'read') core.info(`File: ${formatArgs({ args: event.args })}`);
        else core.info(`Args: ${formatArgs({ args: event.args })}`);
        break;
      case 'tool_execution_end':
        if (event.isError) core.warning(`Tool ${event.toolName} failed`);
        const resultText = extractToolResultText({ result: event.result });
        if (resultText) {
          const truncated =
            resultText.length > 500 ? resultText.slice(0, 500) + '... (truncated)' : resultText;
          core.info(truncated);
        }
        core.endGroup();
        break;
      case 'turn_end':
        core.info('--- Turn ended ---');
        break;
    }
  });

  core.startGroup('Running pi agent');

  // Pre-flight: verify the provider is reachable and the API key has credits.
  // This catches 401/402/503 before the agent loop starts, so we can post a
  // helpful comment instead of silently producing an empty review.
  const baseUrl = config.providerBaseUrl || 'https://api.berget.ai/v1';
  await checkProviderHealth(baseUrl, config.apiKey, providerName, modelId);

  await session.prompt(userPrompt);
  core.endGroup();

  const finalResponse = extractFinalResponse({ messages: session.messages as unknown[] });
  session.dispose();

  return finalResponse;
}

async function checkProviderHealth(
  baseUrl: string,
  apiKey: string,
  providerName: string,
  modelId: string,
): Promise<void> {
  if (!apiKey) {
    core.info('No API key — skipping provider health check');
    return;
  }

  const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
  core.info(`Provider health check: POST ${url} (model: ${modelId})`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ProviderError(
      `Could not reach the model provider at ${baseUrl}: ${(err as Error).message}`,
      0,
      false,
    );
  }

  if (res.ok) {
    core.info(`Provider health check: OK (${res.status})`);
    return;
  }

  let body = '';
  try {
    body = await res.text();
  } catch {
    // ignore
  }

  let errorDetail = body;
  try {
    const parsed = JSON.parse(body);
    errorDetail = parsed?.error?.message ?? parsed?.message ?? body;
  } catch {
    // not JSON, keep raw text
  }

  if (res.status === 402 || res.status === 429 || body.includes('INSUFFICIENT_WALLET_BALANCE')) {
    const consoleUrl = baseUrl.replace(/\/v\d+\/?$/, '').replace('api.', 'console.');
    throw new ProviderError(
      `The model provider returned a billing error (HTTP ${res.status}): ${errorDetail}. ` +
        `The Berget AI API key has run out of credits or been rate-limited. ` +
        `Top up your balance at [console.berget.ai](${consoleUrl || 'https://console.berget.ai'}) to resume AI reviews.`,
      res.status,
      true,
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(
      `The model provider rejected the API key (HTTP ${res.status}): ${errorDetail}. ` +
        `Check that the BERGET_API_KEY secret is set correctly and has not been revoked.`,
      res.status,
      false,
    );
  }

  throw new ProviderError(
    `The model provider returned an error (HTTP ${res.status}): ${errorDetail}`,
    res.status,
    false,
  );
}
