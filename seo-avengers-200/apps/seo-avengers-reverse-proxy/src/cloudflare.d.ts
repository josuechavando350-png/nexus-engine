interface KVNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<any>;
  put(key: string, value: string): Promise<void>;
}
interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}
