/**
 * claim-kernel — exclusive, time-bounded, tenant-isolated claim kernel
 * Effect v4, Schema-first, Ref+HashMap atomic, Config/Random/DateTime via env
 * - acquire: first live wins; same holder refreshes expiry, different holder → AlreadyClaimed; expired → steal with new ClaimId
 * - heartbeat(claimId, holderId): extends expiry; distinct NotFound | NotHolder | ClaimExpired
 * - release(tenantId, workId, holderId): drops live claim; wrong holder → NotHolder; missing/expired → NotFound
 * - inspect: live only Option, never null
 * - purgeExpired: atomic drop + count
 * TTL via Config.duration("CLAIM_TTL") default 5 minutes; ids via Random + Schema.decode + orDie; time via DateTime.now
 */
import { Config, Context, DateTime, Duration, Effect, Equal, HashMap, Layer, Option, Random, Ref, Schema } from "effect"
export const TenantId = Schema.String.pipe(Schema.brand("TenantId"))
export type TenantId = typeof TenantId.Type
export const WorkId = Schema.String.pipe(Schema.brand("WorkId"))
export type WorkId = typeof WorkId.Type
export const HolderId = Schema.String.pipe(Schema.brand("HolderId"))
export type HolderId = typeof HolderId.Type
export const ClaimId = Schema.String.pipe(Schema.brand("ClaimId"))
export type ClaimId = typeof ClaimId.Type
export class Claim extends Schema.Class<Claim>("Claim")({ claimId: ClaimId, tenantId: TenantId, workId: WorkId, holderId: HolderId, expiresAt: Schema.DateTimeUtc }) {}
export class AcquireCommand extends Schema.Class<AcquireCommand>("AcquireCommand")({ tenantId: TenantId, workId: WorkId, holderId: HolderId }) {}
export class AlreadyClaimed extends Schema.TaggedError<AlreadyClaimed>()("AlreadyClaimed", { message: Schema.String }) {}
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { message: Schema.String }) {}
export class NotHolder extends Schema.TaggedError<NotHolder>()("NotHolder", { message: Schema.String }) {}
export class ClaimExpired extends Schema.TaggedError<ClaimExpired>()("ClaimExpired", { message: Schema.String }) {}
export const decodeAcquire = Schema.decodeUnknownEffect(AcquireCommand)
export class ClaimStore extends Context.Service<ClaimStore, {
  at<A>(tenantId: TenantId, workId: WorkId, f: (opt: Option.Option<Claim>) => [A, Option.Option<Claim>]): Effect.Effect<A>
  byId<A>(claimId: ClaimId, f: (opt: Option.Option<Claim>) => [A, Option.Option<Claim>]): Effect.Effect<A>
  purge(now: DateTime.DateTime): Effect.Effect<number>
}>()("claim/ClaimStore") {
  static readonly inMemory = Layer.effect(ClaimStore, Effect.gen(function*() {
    const ref = yield* Ref.make(HashMap.empty<string, Claim>())
    const keyOf = (t: TenantId, w: WorkId): string => `${t}:${w}`
    const at: ClaimStore["Service"]["at"] = (tenantId, workId, f) => Ref.modify(ref, (map) => {
      const k = keyOf(tenantId, workId); const cur = HashMap.get(map, k); const [a, nxt] = f(cur)
      return [a, Option.match(nxt, { onNone: () => HashMap.remove(map, k), onSome: (c) => HashMap.set(map, k, c) })] as const
    })
    const byId: ClaimStore["Service"]["byId"] = (claimId, f) => Ref.modify(ref, (map) => {
      const found = HashMap.findFirst(map, (v) => Equal.equals(v.claimId, claimId)); const cur = Option.map(found, ([, v]) => v); const [a, nxt] = f(cur)
      return [a, Option.match(nxt, { onNone: () => Option.match(found, { onNone: () => map, onSome: ([k]) => HashMap.remove(map, k) }), onSome: (c) => HashMap.set(map, keyOf(c.tenantId, c.workId), c) })] as const
    })
    const purge: ClaimStore["Service"]["purge"] = (now) => Ref.modify(ref, (map) => {
      const live = HashMap.filter(map, (c) => DateTime.isGreaterThan(c.expiresAt, now))
      return [HashMap.size(map) - HashMap.size(live), live] as const
    })
    return ClaimStore.of({ at, byId, purge })
  }))
}
export class ClaimKernel extends Context.Service<ClaimKernel, {
  acquire(cmd: AcquireCommand): Effect.Effect<Claim, AlreadyClaimed>
  heartbeat(claimId: ClaimId, holderId: HolderId): Effect.Effect<Claim, NotFound | NotHolder | ClaimExpired>
  release(tenantId: TenantId, workId: WorkId, holderId: HolderId): Effect.Effect<void, NotFound | NotHolder>
  inspect(tenantId: TenantId, workId: WorkId): Effect.Effect<Option.Option<Claim>>
  purgeExpired(): Effect.Effect<number>
}>()("claim/ClaimKernel") {
  static readonly layer = Layer.effect(ClaimKernel, Effect.gen(function*() {
    const store = yield* ClaimStore
    const ttl = yield* Config.duration("CLAIM_TTL").pipe(Config.withDefault(Duration.minutes(5)))
    const makeId = Effect.flatMap(Random.nextInt, (n) => Schema.decodeUnknownEffect(ClaimId)(`c-${n}`)).pipe(Effect.orDie)
    const acquire = Effect.fn("ClaimKernel.acquire")(function*(cmd: AcquireCommand) {
      const now = yield* DateTime.now; const exp = DateTime.addDuration(now, ttl); const nid = yield* makeId
      const out: Effect.Effect<Claim, AlreadyClaimed> = yield* store.at(cmd.tenantId, cmd.workId, (opt): [Effect.Effect<Claim, AlreadyClaimed>, Option.Option<Claim>] => Option.match(opt, {
        onNone: (): [Effect.Effect<Claim, AlreadyClaimed>, Option.Option<Claim>] => { const c = new Claim({ claimId: nid, tenantId: cmd.tenantId, workId: cmd.workId, holderId: cmd.holderId, expiresAt: exp }); const eff: Effect.Effect<Claim, AlreadyClaimed> = Effect.succeed(c); return [eff, Option.some(c)] as const },
        onSome: (ex): [Effect.Effect<Claim, AlreadyClaimed>, Option.Option<Claim>] => {
          const live = DateTime.isGreaterThan(ex.expiresAt, now)
          if (!live) { const s = new Claim({ claimId: nid, tenantId: cmd.tenantId, workId: cmd.workId, holderId: cmd.holderId, expiresAt: exp }); const eff: Effect.Effect<Claim, AlreadyClaimed> = Effect.succeed(s); return [eff, Option.some(s)] as const }
          if (Equal.equals(ex.holderId, cmd.holderId)) { const r = new Claim({ claimId: ex.claimId, tenantId: ex.tenantId, workId: ex.workId, holderId: ex.holderId, expiresAt: exp }); const eff: Effect.Effect<Claim, AlreadyClaimed> = Effect.succeed(r); return [eff, Option.some(r)] as const }
          const eff: Effect.Effect<Claim, AlreadyClaimed> = Effect.fail(new AlreadyClaimed({ message: "already claimed" })); return [eff, Option.some(ex)] as const
        }
      }))
      return yield* out
    })
    const heartbeat = Effect.fn("ClaimKernel.heartbeat")(function*(claimId: ClaimId, holderId: HolderId) {
      const now = yield* DateTime.now; const exp = DateTime.addDuration(now, ttl)
      const out: Effect.Effect<Claim, NotFound | NotHolder | ClaimExpired> = yield* store.byId(claimId, (opt): [Effect.Effect<Claim, NotFound | NotHolder | ClaimExpired>, Option.Option<Claim>] => Option.match(opt, {
        onNone: (): [Effect.Effect<Claim, NotFound | NotHolder | ClaimExpired>, Option.Option<Claim>] => { const eff: Effect.Effect<Claim, NotFound | NotHolder | ClaimExpired> = Effect.fail(new NotFound({ message: "not found" })); return [eff, Option.none()] as const },
        onSome: (c): [Effect.Effect<Claim, NotFound | NotHolder | ClaimExpired>, Option.Option<Claim>] => {
          if (!Equal.equals(c.holderId, holderId)) { const eff: Effect.Effect<Claim, NotFound | NotHolder | ClaimExpired> = Effect.fail(new NotHolder({ message: "not holder" })); return [eff, Option.some(c)] as const }
          if (!DateTime.isGreaterThan(c.expiresAt, now)) { const eff: Effect.Effect<Claim, NotFound | NotHolder | ClaimExpired> = Effect.fail(new ClaimExpired({ message: "expired" })); return [eff, Option.some(c)] as const }
          const u = new Claim({ claimId: c.claimId, tenantId: c.tenantId, workId: c.workId, holderId: c.holderId, expiresAt: exp }); const eff: Effect.Effect<Claim, NotFound | NotHolder | ClaimExpired> = Effect.succeed(u); return [eff, Option.some(u)] as const
        }
      }))
      return yield* out
    })
    const release = Effect.fn("ClaimKernel.release")(function*(tenantId: TenantId, workId: WorkId, holderId: HolderId) {
      const now = yield* DateTime.now
      const out: Effect.Effect<void, NotFound | NotHolder> = yield* store.at(tenantId, workId, (opt): [Effect.Effect<void, NotFound | NotHolder>, Option.Option<Claim>] => Option.match(opt, {
        onNone: (): [Effect.Effect<void, NotFound | NotHolder>, Option.Option<Claim>] => { const eff: Effect.Effect<void, NotFound | NotHolder> = Effect.fail(new NotFound({ message: "not found" })); return [eff, Option.none()] as const },
        onSome: (c): [Effect.Effect<void, NotFound | NotHolder>, Option.Option<Claim>] => {
          const live = DateTime.isGreaterThan(c.expiresAt, now)
          if (!live) { const eff: Effect.Effect<void, NotFound | NotHolder> = Effect.fail(new NotFound({ message: "not found" })); return [eff, Option.none()] as const }
          if (Equal.equals(c.holderId, holderId)) { const eff: Effect.Effect<void, NotFound | NotHolder> = Effect.void; return [eff, Option.none()] as const }
          const eff: Effect.Effect<void, NotFound | NotHolder> = Effect.fail(new NotHolder({ message: "not holder" })); return [eff, Option.some(c)] as const
        }
      }))
      return yield* out
    })
    const inspect = Effect.fn("ClaimKernel.inspect")(function*(tenantId: TenantId, workId: WorkId) {
      const now = yield* DateTime.now
      return yield* store.at(tenantId, workId, (opt): [Option.Option<Claim>, Option.Option<Claim>] => Option.match(opt, {
        onNone: (): [Option.Option<Claim>, Option.Option<Claim>] => [Option.none<Claim>(), Option.none<Claim>()] as const,
        onSome: (c): [Option.Option<Claim>, Option.Option<Claim>] => { const live = DateTime.isGreaterThan(c.expiresAt, now); return [live ? Option.some(c) : Option.none<Claim>(), opt] as const }
      }))
    })
    const purgeExpired = Effect.fn("ClaimKernel.purgeExpired")(function*() {
      const now = yield* DateTime.now; return yield* store.purge(now)
    })
    return ClaimKernel.of({ acquire, heartbeat, release, inspect, purgeExpired })
  }))
}
export const layer = ClaimKernel.layer.pipe(Layer.provide(Layer.fresh(ClaimStore.inMemory)))
