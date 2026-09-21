// Decoder for the binary event stream Bedrock uses for streaming responses.
//
// Each message is a prelude (total length, headers length, prelude CRC),
// headers (name, type, value), a payload, and a message CRC. For a model
// invocation the interesting messages carry the header :event-type = chunk
// and a JSON payload {"bytes": "<base64>"} whose decoded bytes are one
// Anthropic stream event. This turns that into the text/event-stream form the
// Anthropic translator already understands, so streaming through Bedrock
// reuses the same recomposition path as streaming through Anthropic directly.
//
// CRCs are not verified: the transport is TLS, a corrupted frame fails to
// parse as JSON and is reported as a stream error, and the checksum would add
// a table and a loop for no security gain.

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

interface EventMessage {
  headers: Record<string, string>;
  payload: Uint8Array;
}

function readHeaders(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const headers: Record<string, string> = {};
  let offset = 0;
  while (offset < bytes.byteLength) {
    const nameLength = view.getUint8(offset);
    offset += 1;
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = view.getUint8(offset);
    offset += 1;
    if (type === 7) {
      const length = view.getUint16(offset);
      offset += 2;
      headers[name] = decoder.decode(bytes.subarray(offset, offset + length));
      offset += length;
    } else if (type === 0 || type === 1) {
      headers[name] = type === 0 ? "true" : "false";
    } else if (type === 2) {
      headers[name] = String(view.getInt8(offset));
      offset += 1;
    } else if (type === 3) {
      headers[name] = String(view.getInt16(offset));
      offset += 2;
    } else if (type === 4) {
      headers[name] = String(view.getInt32(offset));
      offset += 4;
    } else if (type === 5 || type === 8) {
      headers[name] = String(view.getBigInt64(offset));
      offset += 8;
    } else if (type === 6) {
      const length = view.getUint16(offset);
      offset += 2 + length;
    } else if (type === 9) {
      offset += 16;
    } else {
      throw new Error("unknown event stream header type");
    }
  }
  return headers;
}

// Pulls complete messages off the front of a buffer, returning them and the
// unconsumed remainder.
export function decodeEventMessages(
  buffer: Uint8Array,
): { messages: EventMessage[]; rest: Uint8Array } {
  const messages: EventMessage[] = [];
  let offset = 0;
  while (buffer.byteLength - offset >= 16) {
    const view = new DataView(
      buffer.buffer,
      buffer.byteOffset + offset,
      buffer.byteLength - offset,
    );
    const totalLength = view.getUint32(0);
    const headersLength = view.getUint32(4);
    if (totalLength > MAX_MESSAGE_BYTES || totalLength < 16 || headersLength > totalLength - 16) {
      throw new Error("event stream message has an invalid length");
    }
    if (buffer.byteLength - offset < totalLength) break;
    const headers = readHeaders(buffer.subarray(offset + 12, offset + 12 + headersLength));
    const payload = buffer.subarray(offset + 12 + headersLength, offset + totalLength - 4);
    messages.push({ headers, payload });
    offset += totalLength;
  }
  return { messages, rest: buffer.subarray(offset) };
}

// Encodes one message. Used by tests to build a stream; CRC fields are zero.
export function encodeEventMessage(
  headers: Record<string, string>,
  payload: Uint8Array,
): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    const view = new DataView(part.buffer);
    part[0] = nameBytes.length;
    part.set(nameBytes, 1);
    part[1 + nameBytes.length] = 7;
    view.setUint16(2 + nameBytes.length, valueBytes.length);
    part.set(valueBytes, 4 + nameBytes.length);
    parts.push(part);
  }
  const headersLength = parts.reduce((sum, part) => sum + part.length, 0);
  const total = 12 + headersLength + payload.length + 4;
  const message = new Uint8Array(total);
  const view = new DataView(message.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headersLength);
  let offset = 12;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }
  message.set(payload, offset);
  return message;
}

// Rewrites a Bedrock response stream into Anthropic-style SSE text.
export function bedrockStreamToSse(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  let closed = false;

  const toSse = (message: EventMessage): string => {
    const messageType = message.headers[":message-type"];
    const eventType = message.headers[":event-type"] ?? messageType ?? "";
    const text = decoder.decode(message.payload);
    if (messageType === "exception" || messageType === "error") {
      const detail = (() => {
        try {
          return String((JSON.parse(text) as { message?: unknown }).message ?? eventType);
        } catch {
          return eventType || "provider stream error";
        }
      })();
      return `event: error\ndata: ${
        JSON.stringify({ type: "error", error: { type: "api_error", message: detail } })
      }\n\n`;
    }
    if (eventType !== "chunk") return "";
    const envelope = JSON.parse(text) as { bytes?: unknown };
    if (typeof envelope.bytes !== "string") throw new Error("chunk without bytes");
    const event = atob(envelope.bytes);
    const decoded = decoder.decode(Uint8Array.from(event, (char) => char.charCodeAt(0)));
    const parsed = JSON.parse(decoded) as { type?: unknown };
    return `event: ${String(parsed.type ?? "message")}\ndata: ${decoded}\n\n`;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let out = "";
      while (!out && !closed) {
        const { value, done } = await reader.read();
        if (done) {
          closed = true;
          break;
        }
        const joined = new Uint8Array(buffer.byteLength + value.byteLength);
        joined.set(buffer);
        joined.set(value, buffer.byteLength);
        const { messages, rest } = decodeEventMessages(joined);
        // Copy the tail so the growing buffer never aliases a consumed chunk.
        buffer = new Uint8Array(rest);
        for (const message of messages) out += toSse(message);
      }
      if (out) controller.enqueue(encoder.encode(out));
      if (closed) controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
