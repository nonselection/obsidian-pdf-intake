import { vi } from "vitest";

export interface TestRequestOptions {
	url: string;
	headers?: Record<string, string>;
}

export interface TestResponse {
	status: number;
	json: Record<string, unknown>;
}

export const requestUrl = vi.fn<(options: TestRequestOptions) => Promise<TestResponse>>();
