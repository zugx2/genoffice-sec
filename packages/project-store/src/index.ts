export { LocalProjectApi } from './local.js'
export { ProjectStore } from './store.js'
export {
  RemoteProjectApi,
  RemoteProjectApiError,
  RemoteProjectConflictError,
  RemoteProjectError,
  RemoteProjectUnavailableError,
} from './remote.js'
export type {
  RemoteProjectApiOptions,
  RemoteProjectErrorCode,
  RemoteProjectTransport,
} from './remote.js'
export {
  SCOPE_TEXT_MAX_CHARS,
  TEXT_MAX_CHARS,
  TEXT_TRUNCATED_MARK,
  TOOL_FIELD_MAX_CHARS,
} from './store.js'
export type {
  ChatMessage,
  ChatMeta,
  ChatScope,
  ProjectData,
  ProjectIndex,
  ProjectInfo,
  ProjectSummary,
  TimelineEntry,
  ToolActivity,
} from './types.js'
export type {
  AppendChatArgs,
  LoadChatArgs,
  ProjectApi,
  RebindChatArgs,
  ResolveChatArgs,
  ResolveChatResult,
} from './ipc.js'
