/**
 * Project-store routing (docs/cloud-backend-auth.md §E.1 and "Phase 6
 * conflict & routing policy"): one `ProjectApi` that decides per request
 * which store serves it.
 *
 * - session active → the remote adapter (packages/project-store's
 *   `RemoteProjectApi`, built on the shared backend client's transport —
 *   Bearer + refresh-once-on-401, the SSRF-gated construction);
 * - no session → the local adapter, exactly as before the cloud existed;
 * - request-level offline fallback: when the remote attempt fails with a
 *   `RemoteProjectUnavailableError` (transport failure, 5xx, dead session)
 *   the request is re-served from the local store and the outcome is
 *   flagged `'remote-fallback-local'`. A definitive server answer — the
 *   typed 409 conflict above all — is NOT a fallback: it surfaces, because
 *   silently re-writing the message into the local store would fork the
 *   chat across stores (a project created remotely stays remote; there is
 *   no cross-mode data migration in this phase).
 *
 * The switch is observable: `projectStoreSource()` says which store is live
 * (the session state), `lastRequestSource()` says which store actually
 * served the previous request (including the offline fallback). Everything
 * stays main-side — the renderer never sees a URL, token, or source beyond
 * these two getters' values.
 */

import type {
  AppendChatArgs,
  ChatMessage,
  LoadChatArgs,
  ProjectApi,
  RebindChatArgs,
  ResolveChatArgs,
  ResolveChatResult,
} from '@genoffice/project-store'
import { RemoteProjectError } from '@genoffice/project-store'

/** Which store served the previous request. */
export type ProjectRequestSource = 'local' | 'remote' | 'remote-fallback-local'

export interface RoutingProjectApiOptions {
  /** the local leg (docs-main's LocalProjectApi over the shared store) */
  local: ProjectApi
  /**
   * Builds the remote leg on the first remote request (the shell composes
   * `RemoteProjectApi` over the shared backend client's transport here), or
   * resolves undefined when it cannot be built (no session manager,
   * config-gated client) — which serves that request locally. Called once;
   * the result is reused (a config-gated client never becomes usable).
   */
  remote: () => Promise<ProjectApi | undefined>
  /** session gate: true while a cloud session is active */
  sessionActive: () => boolean
}

/** True for exactly the failures that mean "the remote store is unusable". */
function isRemoteUnavailable(error: unknown): boolean {
  return error instanceof RemoteProjectError && error.code === 'unavailable'
}

export class RoutingProjectApi implements ProjectApi {
  private readonly local: ProjectApi
  private readonly options: Omit<RoutingProjectApiOptions, 'local'>
  private remote: ProjectApi | undefined
  /** one construction attempt; a config-gated client never becomes usable */
  private remoteLoad: Promise<ProjectApi | undefined> | undefined
  private lastSource: ProjectRequestSource | undefined

  constructor(options: RoutingProjectApiOptions) {
    this.local = options.local
    this.options = options
  }

  /** Which store is live right now — the switch, before any request runs. */
  projectStoreSource(): 'local' | 'remote' {
    return this.options.sessionActive() ? 'remote' : 'local'
  }

  /** Which store served the previous request (`'remote-fallback-local'` = remote failed over). */
  lastRequestSource(): ProjectRequestSource | undefined {
    return this.lastSource
  }

  /** Builds (once) the remote adapter through the injected factory. */
  private loadRemote(): Promise<ProjectApi | undefined> {
    return (this.remoteLoad ??= this.options.remote().then(
      (remote) => {
        this.remote = remote
        return remote
      },
      (error: unknown) => {
        // construction failure (config gate, session manager absent): local-only
        console.warn('[project-routing] building the remote project store failed:', error)
        return undefined
      },
    ))
  }

  /** Routes one operation: remote while logged in, local otherwise. */
  private async route<T>(op: (api: ProjectApi) => Promise<T>): Promise<T> {
    if (!this.options.sessionActive()) {
      this.lastSource = 'local'
      return op(this.local)
    }
    const remote = await this.loadRemote()
    if (remote === undefined) {
      this.lastSource = 'remote-fallback-local'
      return op(this.local)
    }
    try {
      const result = await op(remote)
      this.lastSource = 'remote'
      return result
    } catch (error) {
      if (!isRemoteUnavailable(error)) {
        // a definitive remote answer (409 conflict, 400, 404): surfaced
        this.lastSource = 'remote'
        throw error
      }
      // offline fallback for THIS request only — the next one retries remote
      console.warn('[project-routing] remote store unavailable, serving from local:', error)
      this.lastSource = 'remote-fallback-local'
      return op(this.local)
    }
  }

  resolveChat(args: ResolveChatArgs): Promise<ResolveChatResult> {
    return this.route((api) => api.resolveChat(args))
  }

  appendChat(args: AppendChatArgs): Promise<void> {
    return this.route((api) => api.appendChat(args))
  }

  loadChat(args: LoadChatArgs): Promise<ChatMessage[]> {
    return this.route((api) => api.loadChat(args))
  }

  rebindChat(args: RebindChatArgs): Promise<ResolveChatResult> {
    return this.route((api) => api.rebindChat(args))
  }
}
