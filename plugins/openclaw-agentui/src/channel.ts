import { createChatChannelPlugin, type OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { runHosts } from './hosts.js';
import { AgentUIBridge, CHANNEL, HOME_CONVERSATION, MAX_MEDIA, readMedia } from './bridge.js';
import { AgentUIClient } from './client.js';
import type { Capabilities, Media } from './protocol.js';
import { agentUIClients } from './runtime.js';
import { listSubAgents } from './agents.js';

export interface AgentUIAccount {
  accountId: string | null;
  enabled: boolean;
  url: string;
  token: string;
  name: string;
}

const CAPABILITIES: Capabilities = {
  sessions: true,
  abort: true,
  approvals: true,
  subagents: false, // TODO: sub-agent sessions (sessions_spawn tool) via agent events
  reasoning: true,
  toolDetails: true,
  skills: true,
  jobs: true,
  jobControl: true,
  sessionDelete: true,
  models: true,
  attachments: { images: true, files: true, maxBytes: MAX_MEDIA },
};

const sectionOf = (cfg: OpenClawConfig): Record<string, any> => ((cfg.channels as Record<string, any> | undefined)?.[CHANNEL] ?? {});

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): AgentUIAccount {
  const s = sectionOf(cfg);
  return {
    accountId: accountId ?? null,
    enabled: s.enabled !== false && Boolean(s.url && s.token),
    url: String(s.url ?? process.env.AGENTUI_URL ?? ''),
    token: String(s.token ?? process.env.AGENTUI_TOKEN ?? ''),
    name: String(s.name ?? 'OpenClaw'),
  };
}

/** Proactive message (cron, message tool, deferred delivery): outside any AgentUI run. */
async function sendOutbound(
  cfg: OpenClawConfig,
  accountId: string | null | undefined,
  to: string,
  text: string | undefined,
  media: Media[] = [],
) {
  const id = crypto.randomUUID();
  const msg = {
    type: 'outbound' as const,
    id,
    ...(to && to !== HOME_CONVERSATION ? { conversationId: to } : {}),
    ...(text ? { text } : {}),
    ...(media.length ? { media } : {}),
  };
  const client = agentUIClients.get(accountId ?? 'default') ?? [...agentUIClients.values()][0];
  if (client) {
    client.send(msg);
    return { messageId: id };
  }
  // Outside the gateway process (CLI `openclaw message send`, isolated cron): one-off send connection.
  const account = resolveAccount(cfg, accountId);
  if (!account.url || !account.token) throw new Error('AgentUI: channels.agentui.url and token are required');
  const once = new AgentUIClient({
    url: account.url,
    token: account.token,
    agent: { type: 'openclaw', name: account.name },
    capabilities: CAPABILITIES,
    mode: 'send-only',
    onMessage: () => {},
  });
  once.start();
  try {
    if (!(await once.waitReady(10_000))) throw new Error('AgentUI injoignable');
    once.send(msg);
    await new Promise((r) => setTimeout(r, 200)); // let the frame leave before closing
  } finally {
    once.stop();
  }
  return { messageId: id };
}

export const agentUIPlugin = createChatChannelPlugin<AgentUIAccount>({
  base: {
    id: CHANNEL,
    meta: { id: CHANNEL, label: 'AgentUI', selectionLabel: 'AgentUI', docsPath: '/channels/agentui', blurb: 'AgentUI chat PWA used as a channel.' },
    capabilities: { chatTypes: ['direct'], media: true },
    config: {
      listAccountIds: () => ['default'],
      resolveAccount,
      inspectAccount(cfg) {
        const s = sectionOf(cfg);
        return { enabled: s.enabled !== false && Boolean(s.url), configured: Boolean(s.url && s.token), tokenStatus: s.token ? 'available' : 'missing' };
      },
    },
    setup: {
      applyAccountConfig: ({ cfg, input }) => ({
        ...cfg,
        channels: { ...cfg.channels, [CHANNEL]: { ...sectionOf(cfg), ...input } },
      }),
    },
    // Targets of direct sends (message tool, crons, `openclaw message send`): an AgentUI chat id,
    // or "home" for the home chat.
    messaging: {
      normalizeTarget: (raw) => raw.trim().replace(/^agentui:/i, '') || undefined,
      targetResolver: {
        looksLikeId: () => true,
        hint: `<AgentUI chat id> or ${HOME_CONVERSATION}`,
        resolveTarget: async ({ normalized }) => ({ to: normalized, kind: 'user', source: 'normalized' }),
      },
    },
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        if (!account.url || !account.token) throw new Error('AgentUI: channels.agentui.url and token are required');
        const log = (msg: string) => ctx.log?.info?.(`[agentui] ${msg}`);
        let client: AgentUIClient | undefined;
        const bridge = new AgentUIBridge({ cfg: ctx.cfg, accountId: ctx.accountId, client: () => client, log });
        client = new AgentUIClient({
          url: account.url,
          token: account.token,
          agent: { type: 'openclaw', name: account.name, version: process.env.OPENCLAW_VERSION },
          capabilities: CAPABILITIES,
          activeRuns: () => bridge.activeRuns(),
          subAgents: () => listSubAgents(ctx.cfg),
          onMessage: (msg) => bridge.handle(msg),
          onStatus: (connected, detail) => ctx.setStatus({ ...ctx.getStatus(), connected, lastError: connected ? null : (detail ?? null) }),
          log,
        });
        agentUIClients.set(ctx.accountId, client);
        runHosts.set(ctx.accountId, bridge);
        client.start();
        await new Promise<void>((resolve) => {
          if (ctx.abortSignal.aborted) return resolve();
          ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        client.stop();
        agentUIClients.delete(ctx.accountId);
        runHosts.delete(ctx.accountId);
      },
    },
  },
  // Access is controlled by the AgentUI token (the user is authenticated by AgentUI).
  security: {
    dm: {
      channelKey: CHANNEL,
      resolvePolicy: () => 'open',
      resolveAllowFrom: () => ['*'],
      defaultPolicy: 'open',
    },
  },
  threading: { topLevelReplyToMode: 'off' },
  outbound: {
    base: { deliveryMode: 'direct' },
    attachedResults: {
      channel: CHANNEL,
      sendText: async (ctx) => sendOutbound(ctx.cfg, ctx.accountId, ctx.to, ctx.text),
      sendMedia: async (ctx) => {
        const media = ctx.mediaUrl ? [await readMedia(ctx.mediaUrl, ctx.mediaReadFile)] : [];
        return sendOutbound(ctx.cfg, ctx.accountId, ctx.to, ctx.text, media);
      },
    },
  },
});
