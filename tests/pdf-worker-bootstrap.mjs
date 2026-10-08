import { Buffer } from "node:buffer";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("PDF.js test worker requires a parent port");

Object.defineProperty(globalThis, "process", { configurable: true, value: undefined });
globalThis.self = globalThis;
globalThis.postMessage = (message, transfer = []) => parentPort.postMessage(message, transfer);

const listeners = new Map();
globalThis.addEventListener = (type, listener) => {
	if (type === "message") {
		const wrappedListener = (data) => listener({ data });
		listeners.set(listener, wrappedListener);
		parentPort.on("message", wrappedListener);
	}
};
globalThis.removeEventListener = (type, listener) => {
	if (type !== "message") return;
	const wrappedListener = listeners.get(listener);
	if (!wrappedListener) return;
	parentPort.off("message", wrappedListener);
	listeners.delete(listener);
};
Object.defineProperty(globalThis, "onmessage", {
	configurable: true,
	value: null,
});

const workerModule = `data:text/javascript;base64,${Buffer.from(workerData).toString("base64")}`;
await import(workerModule);
