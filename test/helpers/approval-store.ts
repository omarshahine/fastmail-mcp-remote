import { SendApprovalStore } from "../../src/send-approval";

export class MemoryStorage {
  private values = new Map<string, unknown>();
  alarm?: number;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(time?: number): Promise<void> {
    this.alarm = time;
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }
}

export class MemoryState {
  readonly storage = new MemoryStorage();
  private queue: Promise<unknown> = Promise.resolve();

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.queue.then(callback);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** In-memory stand-in for the SEND_APPROVALS Durable Object namespace. */
export function approvalNamespace() {
  const stores = new Map<string, SendApprovalStore>();
  return {
    getByName(id: string) {
      let store = stores.get(id);
      if (!store) {
        store = new SendApprovalStore(new MemoryState() as unknown as DurableObjectState, {} as Env);
        stores.set(id, store);
      }
      return { fetch: (request: Request | string, init?: RequestInit) => store!.fetch(new Request(request, init)) };
    },
  };
}
