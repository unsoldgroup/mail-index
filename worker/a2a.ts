import { dispatch, toolList } from '../src/mcp/server.js';
import type { ToolContext } from '../src/mcp/tools.js';

export function agentCard(origin: string) {
  return {
    name: 'mail-index',
    description: 'Private mail intelligence for compact, ranked Recall over an operator-owned index.',
    url: `${origin}/a2a`,
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    skills: toolList().map((tool) => ({ id: tool.name, name: tool.name, description: tool.description, tags: ['mail', 'recall'] })),
  };
}

function error(id: unknown, code: number, message: string) { return Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }); }

export async function handleA2a(request: Request, context: ToolContext): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return error(null, -32700, 'Parse error'); }
  const id = body['id'];
  if (body['method'] !== 'message/send') return error(id, -32601, 'Method not found: synchronous message/send only');
  const params = body['params'] as { message?: { parts?: { kind?: string; type?: string; data?: Record<string, unknown>; text?: string }[] } } | undefined;
  const part = params?.message?.parts?.find((candidate) => candidate.kind === 'data' || candidate.type === 'data');
  if (!part?.data || typeof part.data['tool'] !== 'string') return error(id, -32602, 'Structured DataPart with tool and args is required');
  try {
    const result = await dispatch(context, part.data['tool'], (part.data['args'] ?? {}) as Record<string, unknown>);
    return Response.json({ jsonrpc: '2.0', id, result: { role: 'agent', parts: [{ kind: 'data', data: result }] } });
  } catch (cause) { return error(id, -32603, cause instanceof Error ? cause.message : String(cause)); }
}
