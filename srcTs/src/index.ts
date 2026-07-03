// Core types
export {
  Artifact,
  FileArtifact,
  DirectoryArtifact,
  VirtualArtifact,
} from "./artifact";
export { file, directory, virtual } from "./artifact";

export { Task, type TaskConfig, type BuildContext } from "./task";

export { Build, type BuildOptions } from "./build";

// Result types
export { Result, Outcome } from "./result";

// State implementations
export { type State, MemoryState, JsonState } from "./state";
