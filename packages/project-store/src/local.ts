/**
 * Local `ProjectApi` — the main-process adapter the `project:*` IPC handlers
 * have served since P0, lifted onto the `ProjectApi` interface so a routing
 * layer (remote-when-logged-in, local otherwise) can swap implementations
 * per request.
 *
 * The unsaved-file handling lives here (not in the IPC handler): a chat with
 * no file on disk resolves to the default project plus the renderer's temp
 * id (`unsaved-<timestamp>` when it has none), exactly as the handlers did.
 * Sheets' `sessionId` → path resolution stays in the shell (it needs the
 * sheets session map); this adapter only ever sees `filePath`.
 */

import type {
  AppendChatArgs,
  LoadChatArgs,
  ProjectApi,
  RebindChatArgs,
  ResolveChatArgs,
  ResolveChatResult,
} from './ipc.js'
import { ProjectStore } from './store.js'

export class LocalProjectApi implements ProjectApi {
  private readonly store: ProjectStore

  constructor(store: ProjectStore) {
    this.store = store
  }

  async resolveChat(args: ResolveChatArgs): Promise<ResolveChatResult> {
    this.store.ensureDefaultProject()
    if (!args.filePath) {
      return { projectId: 'default', chatId: args.tempChatId ?? `unsaved-${Date.now()}` }
    }
    return this.store.resolveChatForFile(args.filePath)
  }

  async appendChat(args: AppendChatArgs): Promise<void> {
    const msg: Parameters<ProjectStore['appendChatMessage']>[2] = {
      role: args.role,
      text: args.text,
    }
    if (args.tools !== undefined) msg.tools = args.tools
    if (args.attachments !== undefined) msg.attachments = args.attachments
    if (args.scope !== undefined) msg.scope = args.scope
    this.store.appendChatMessage(args.projectId, args.chatId, msg)
  }

  async loadChat(args: LoadChatArgs): Promise<ReturnType<ProjectStore['loadChat']>> {
    return this.store.loadChat(args.projectId, args.chatId, args.limit ?? 200)
  }

  async rebindChat(args: RebindChatArgs): Promise<ResolveChatResult> {
    if (args.newFilePath) {
      return this.store.rebindChatToFile(args.projectId, args.tempChatId, args.newFilePath)
    }
    if (args.newChatId) this.store.rebindChat(args.projectId, args.tempChatId, args.newChatId)
    return { projectId: args.projectId, chatId: args.newChatId ?? args.tempChatId }
  }
}
