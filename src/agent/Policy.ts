/**
 * AgentPolicy — per-agent opt-out consumed from the agent's `request.body`.
 *
 * An agent declares `"opencode-effect-harness": false` in its `request.body`
 * (opencode.jsonc agent definition) to opt out of Effect guidance, gating, and
 * pattern feedback — e.g. agents that never write Effect code. The key is
 * CONSUMED (removed from the outgoing request body) and a `skill` permission
 * deny is added for the bundled `effect-*` skills, mirroring the enforcement
 * plugin's contract. Opted-out agents keep origin-based child-session
 * restrictions, which are a security boundary, not guidance policy.
 */
import { Option, Predicate } from 'effect';

export const OPT_OUT_KEY = 'opencode-effect-harness';

export namespace AgentPolicy {
	export interface AgentPolicyTarget {
		readonly id: string;
		readonly request: {
			readonly body: Record<string, unknown>;
		};
		readonly permissions: Array<{
			readonly action: string;
			readonly resource: string;
			readonly effect: 'allow' | 'ask' | 'deny';
		}>;
	}

	/**
	 * Consume the opt-out from one agent draft. Mutates the HOST DRAFT in place
	 * (request.body and permissions are host-owned mutable records by contract)
	 * and returns whether the agent is opted out.
	 */
	export const consumeOptOut = (agent: AgentPolicyTarget): boolean => {
		const disabled = agent.request.body[OPT_OUT_KEY] === false;
		if (OPT_OUT_KEY in agent.request.body) {
			delete agent.request.body[OPT_OUT_KEY];
		}
		if (!disabled) return false;
		agent.permissions.push({ action: 'skill', resource: 'effect-*', effect: 'deny' });
		return true;
	};

	/** Pure predicate over the collected disabled-agent ids. */
	export const isDisabled = (disabled: ReadonlySet<string>, agent: unknown): boolean => {
		const id = Predicate.isString(agent) ? Option.some(agent) : Option.none<string>();
		return Option.isSome(id) && disabled.has(id.value);
	};
}
