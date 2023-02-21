export type QueueData = {
	ts: number
	from: string
	to: string
	subject: string
}

/** synced with https://replit.com/@jachands/Email-to-Discord-Embed-Queue#src/types.ts */
export interface EmbedQueueData {
  /** Envelope From attribute of the email message. */
  from: string
  /** Envelope To attribute of the email message. */
  to: string
  /** Subject of email */
  subject: string
	/** Path to raw email in R2 bucket */
	r2path: string
	/** timestamp of the message */
	ts: number
}

export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	// MY_BUCKET: R2Bucket;
	DISCORDHOOK: string
	QUEUE: Queue<QueueData>
	DISCORDEMBED: Queue<EmbedQueueData>
	STATS: AnalyticsEngineDataset
	ALLSTATS: AnalyticsEngineDataset
	DISQUSSTATS: AnalyticsEngineDataset
	R2: R2Bucket
	B2_AWS_ACCESS_KEY_ID: string
	B2_AWS_SECRET_ACCESS_KEY: string
	B2_AWS_DEFAULT_REGION: string
	B2_ENDPOINT: string
	ENVIRONMENT: string
	LOGTAIL_KEY: string
}