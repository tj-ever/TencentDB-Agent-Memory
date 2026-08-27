import type { PresetIdentity } from "../session/preset.js";
import type { SessionInitData, SessionInitState, TeamOption } from "../session/types.js";

export interface TrustedRegistration {
  selection: SessionInitData;
  state: SessionInitState;
  teams: TeamOption[];
}

/** 将已通过 Team 成员校验的服务端 binding 转为状态机可直接消费的数据。 */
export function createTrustedRegistration(
  preset: PresetIdentity | undefined,
  sessionKey: string,
  userId: string,
): TrustedRegistration | null {
  if (!preset?.teamId || !preset.agentId) return null;
  const teams: TeamOption[] = [{
    team_id: preset.teamId,
    team_name: preset.teamId,
    agents: [{ agent_id: preset.agentId, agent_name: preset.agentId }],
    tasks: preset.taskId ? [{ task_id: preset.taskId, task_name: preset.taskId }] : [],
  }];
  return {
    selection: { agent_id: preset.agentId, task_id: preset.taskId },
    teams,
    state: {
      status: "uninitialized",
      keyId: sessionKey,
      startedAt: Date.now(),
      attemptCount: 0,
      userId,
      cachedTeams: teams,
      selectedTeamId: preset.teamId,
    },
  };
}
