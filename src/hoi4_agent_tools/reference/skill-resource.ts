import type { CoreEngine } from '../core/engine.js';
import {
  requireOperationScope,
  resolveOperationWorkspaceId,
  type OperationContext,
} from '../core/operation-context.js';
import { ServiceError } from '../core/result.js';
import { SKILL_NAME_PATTERN } from '../schemas/skill.js';
import { readSkillText, skillNames } from './skills.js';

/** The same skill text hoi4.skill serves, as one resource per skill: its SKILL.md. */
export const skillResourceDefinition = {
  name: 'skill',
  uriTemplate: 'hoi4-agent://workspace/{workspaceId}/skill/{name}',
  title: 'HOI4 modding skill',
  description:
    "A skill's SKILL.md at the kit version HOI4 Mod Setup pinned for the mod; _meta carries its sha256 and kit revision. An edited file is refused; read it with hoi4.skill and acceptLocalEdits. Use workspace current for the client's mod.",
  mimeType: 'text/markdown',
};

const skillUri = (workspaceId: string, name: string) =>
  `hoi4-agent://workspace/${encodeURIComponent(workspaceId)}/skill/${name}`;

/** The current workspace's skills, for resources/list. A mod without skills lists none. */
export async function listSkillResources(
  engine: CoreEngine,
  context: OperationContext,
  signal?: AbortSignal,
) {
  requireOperationScope(context, 'hoi4:read');
  try {
    const workspaceId = await resolveOperationWorkspaceId(engine, context, 'current', signal);
    const workspace = engine.resolver.get(workspaceId, context.principal);
    return (await skillNames(workspace, signal)).map((name) => ({
      uri: skillUri('current', name),
      name: `skill:${name}`,
      title: name,
      mimeType: 'text/markdown',
    }));
  } catch (error) {
    if (signal?.aborted) throw error;
    // No current mod (several configured, none chosen) is an empty list, not a failure.
    return [];
  }
}

export async function readSkillResource(
  engine: CoreEngine,
  uriInput: string,
  context: OperationContext,
  signal?: AbortSignal,
) {
  requireOperationScope(context, 'hoi4:read');
  let workspaceId: string;
  let name: string;
  try {
    const uri = new URL(uriInput);
    const segments = uri.pathname.split('/');
    if (
      uri.protocol !== 'hoi4-agent:' ||
      uri.hostname !== 'workspace' ||
      uri.search !== '' ||
      segments.length !== 4 ||
      segments[0] !== '' ||
      segments[2] !== 'skill'
    )
      throw new Error('Invalid skill resource path');
    workspaceId = decodeURIComponent(segments[1]!);
    name = segments[3]!;
    if (!SKILL_NAME_PATTERN.test(name)) throw new Error('Invalid skill name');
  } catch {
    throw new ServiceError('RESOURCE_URI_INVALID', 'Resource URI is invalid');
  }
  const resolved = await resolveOperationWorkspaceId(engine, context, workspaceId, signal);
  const workspace = engine.resolver.get(resolved, context.principal);
  const skill = await readSkillText(workspace, name, 'SKILL.md', signal);
  return {
    contents: [
      {
        uri: uriInput,
        mimeType: 'text/markdown',
        text: skill.text,
        _meta: {
          sha256: skill.sha256,
          state: skill.state,
          kitRevision: skill.kit?.revision ?? null,
          kitRelease: skill.kit?.release ?? null,
        },
      },
    ],
  };
}
