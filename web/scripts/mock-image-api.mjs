import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const port = Number(process.env.MOCK_IMAGE_API_PORT || 17372);
const fixtureDirectory = new URL("./fixtures/", import.meta.url);
const samplePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XhM4WQAAAABJRU5ErkJggg==", "base64");
const largePng = Buffer.concat([samplePng, Buffer.alloc(8 * 1024 * 1024)]);
const scenarios = [
    "mock-json-url",
    "mock-json-base64",
    "mock-sse-chunked",
    "mock-truncated-json",
    "mock-504-html",
    "mock-large-base64",
    "mock-stream-error",
    "mock-empty",
];

const server = createServer(async (request, response) => {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
    }
    if (request.url === "/v1/models") {
        sendJson(response, 200, { object: "list", data: scenarios.map((id) => ({ id, object: "model", owned_by: "local-fixture" })) });
        return;
    }
    if (request.url === "/fixtures/sample.png") {
        response.writeHead(200, { "Content-Type": "image/png", "Content-Length": samplePng.length });
        response.end(samplePng);
        return;
    }
    if (!request.url || !["/v1/images/generations", "/v1/images/edits", "/v1/responses"].includes(request.url)) {
        sendJson(response, 404, { error: { message: "fixture endpoint not found" } });
        return;
    }

    const body = await readBody(request);
    const scenario = scenarios.find((name) => body.includes(name)) || "mock-json-base64";
    const replacements = {
        "__IMAGE_BASE64__": samplePng.toString("base64"),
        "__LARGE_IMAGE_BASE64__": largePng.toString("base64"),
        "__IMAGE_URL__": `http://127.0.0.1:${port}/fixtures/sample.png`,
    };

    if (scenario === "mock-504-html") {
        response.writeHead(504, { "Content-Type": "text/html; charset=utf-8" });
        response.end(await loadFixture("gateway.html", replacements));
        return;
    }
    if (scenario === "mock-stream-error") {
        await sendChunked(response, await loadFixture("stream-error.sse", replacements));
        return;
    }
    if (scenario === "mock-sse-chunked") {
        const fixture = request.url === "/v1/responses" ? "responses-chunked.sse" : "images-chunked.sse";
        await sendChunked(response, await loadFixture(fixture, replacements));
        return;
    }
    if (scenario === "mock-truncated-json") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(await loadFixture("truncated-json.txt", replacements));
        return;
    }
    if (scenario === "mock-empty") {
        sendJson(response, 200, { created: Date.now(), data: [] });
        return;
    }

    const fixture = scenario === "mock-json-url" ? "image-url.json" : scenario === "mock-large-base64" ? "large-base64.json" : "image-base64.json";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(await loadFixture(fixture, replacements));
});

server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Image API fixture server: http://127.0.0.1:${port}/v1\nModels: ${scenarios.join(", ")}\n`);
});

function setCorsHeaders(response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(response, status, payload) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
}

async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

async function loadFixture(name, replacements) {
    let value = await readFile(fileURLToPath(new URL(name, fixtureDirectory)), "utf8");
    Object.entries(replacements).forEach(([key, replacement]) => {
        value = value.replaceAll(key, replacement);
    });
    return value;
}

async function sendChunked(response, content) {
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
    const sizes = [1, 7, 19, 3, 43, 11];
    let offset = 0;
    let index = 0;
    while (offset < content.length) {
        const size = sizes[index % sizes.length];
        response.write(content.slice(offset, offset + size));
        offset += size;
        index += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    response.end();
}
