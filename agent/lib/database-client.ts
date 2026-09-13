/** pg-native clients retain their full API while normalizing errors and protecting checked-out connections. */
import { Client, Pool, type ClientConfig, type PoolConfig } from "pg";
import { normalizePostgresError } from "./database-errors.js";
import { AppError } from "./app-error.js";

class ApplicationDatabaseClient extends Client {
  private connectionErrorReported = false;
  private transactionFailure: unknown;
  private inTransaction = false;

  reportConnectionError(error: Error) {
    if (this.connectionErrorReported) return;
    this.connectionErrorReported = true;
    console.error(JSON.stringify({ code: "AGENT_DATABASE_CONNECTION_LOST",errorName: error.name,
      databaseCode: "code" in error ? error.code : undefined }));
  }

  resetTransactionState() { this.inTransaction=false; this.transactionFailure=undefined; }

  constructor(config?: string | ClientConfig) {
    super(config);
    this.on("error",error => this.reportConnectionError(error));
    const original = this.query.bind(this);
    this.query = ((...args: unknown[]) => {
      const query = args[0];
      const text = typeof query === "string" ? query : query && typeof query === "object" && "text" in query ? String(query.text) : "";
      const rollback = /^\s*ROLLBACK\b/iu.test(text);
      if (/^\s*BEGIN\b/iu.test(text)) this.inTransaction=true;
      const failed = (error: unknown) => {
        const normalized = normalizePostgresError(error);
        if (rollback && this.transactionFailure !== undefined) {
          return new AggregateError([this.transactionFailure,normalized], "AGENT_DATABASE_ROLLBACK_FAILED", { cause: this.transactionFailure });
        }
        if (this.inTransaction && this.transactionFailure === undefined) this.transactionFailure=normalized;
        return normalized;
      };
      const succeeded = () => { if (/^\s*(COMMIT|ROLLBACK)\b/iu.test(text)) this.resetTransactionState(); };
      const last = args.at(-1);
      if (typeof last === "function") {
        args[args.length-1] = (error: unknown,...values: unknown[]) => {
          if (!error) succeeded();
          return Reflect.apply(last,undefined,[error ? failed(error) : error,...values]);
        };
      }
      try {
        const result = Reflect.apply(original,this,args);
        return result instanceof Promise ? result.then(value => { succeeded(); return value; },error => { throw failed(error); }) : result;
      } catch (error) { throw failed(error); }
    }) as typeof this.query;
  }
}

export function createApplicationDatabasePool(config: PoolConfig): Pool {
  const pool = new Pool({ ...config,Client: ApplicationDatabaseClient });
  pool.on("error",(error,client) => {
    if (!(client instanceof ApplicationDatabaseClient)) throw new AppError("AGENT_DATABASE_CLIENT_INVALID", "Не удалось проверить обработчик соединения с базой");
    client.reportConnectionError(error);
  });
  pool.on("release",(_error,client) => {
    if (!(client instanceof ApplicationDatabaseClient)) throw new AppError("AGENT_DATABASE_CLIENT_INVALID", "Не удалось проверить обработчик соединения с базой");
    client.resetTransactionState();
  });
  const connect = pool.connect.bind(pool);
  pool.connect = ((...args: unknown[]) => {
    const callback = args[0];
    if (typeof callback === "function") args[0] = (error: unknown,...values: unknown[]) =>
      Reflect.apply(callback,undefined,[error ? normalizePostgresError(error) : error,...values]);
    const result = Reflect.apply(connect,pool,args);
    return result instanceof Promise ? result.catch(error => { throw normalizePostgresError(error); }) : result;
  }) as typeof pool.connect;
  // Pool.query has its own early client-error listener; normalize that path as well as Client.query.
  const query=pool.query.bind(pool);
  pool.query=((...args: unknown[]) => {
    const callback=args.at(-1);
    if (typeof callback === "function") args[args.length-1]=(error: unknown,...values: unknown[]) =>
      Reflect.apply(callback,undefined,[error ? normalizePostgresError(error) : error,...values]);
    try {
      const result=Reflect.apply(query,pool,args);
      return result instanceof Promise ? result.catch(error => { throw normalizePostgresError(error); }) : result;
    } catch (error) { throw normalizePostgresError(error); }
  }) as typeof pool.query;
  return pool;
}
