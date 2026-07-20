export interface UpdateSchedulerStatus {
  installed: boolean;
  detail: string;
}

/** OS-owned periodic invocation of the signed `xangi update` command. */
export interface UpdateSchedulerAdapter {
  install(): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<UpdateSchedulerStatus>;
}

export const externallyManagedUpdateScheduler: UpdateSchedulerAdapter = {
  async install(): Promise<void> {},
  async uninstall(): Promise<void> {},
  async status(): Promise<UpdateSchedulerStatus> {
    return { installed: true, detail: 'externally managed' };
  },
};
