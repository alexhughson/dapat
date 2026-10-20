import type { Task } from "./task"

/**
 * A group of tasks in a build. `setTasks(group, tasks)` replaces the whole task list of the group.
 * The object is the identity: two groups with the same label are two different groups.
 * The label is only for error messages.
 */
export class TaskGroup {
  constructor(readonly label: string) {}
}

/** A group and its new tasks, in one setTasksOfGroups step of the build. */
export type GroupTasks = { group: TaskGroup; tasks: readonly Task[] }
