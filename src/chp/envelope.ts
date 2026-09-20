// ============================================================
// CogniTrader BSC — CHP payload envelope (port of chp.payloads)
// The envelope is a transport-integrity marker: it validates
// STRUCTURE only — it is NOT a content-integrity check. Content
// integrity is the ledger's own SHA-256 body digest (ledger.ts).
// ============================================================

import crypto from 'crypto';

export interface PayloadEnvelope {
  route: string;
  payloadId: string;
  body: string;
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function buildPayloadEnvelope(
  body: string,
  route = 'RX',
  payloadId?: string,
): PayloadEnvelope {
  let id = payloadId;
  if (!id) {
    id = '';
    for (let i = 0; i < 6; i++) {
      id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
    }
  }
  return { route, payloadId: id, body };
}

export function renderEnvelope(envelope: PayloadEnvelope): string {
  return (
    `BEGIN_PAYLOAD [${envelope.route}] [${envelope.payloadId}]\n` +
    `${envelope.body}\n` +
    `END_PAYLOAD [${envelope.route}] [${envelope.payloadId}]`
  );
}

/**
 * Port of chp.payloads.validate_payload_envelope: the BEGIN/END markers
 * exist and carry identical [route] [payload_id] parameters. Structure
 * only — a tampered body inside an untouched envelope still validates.
 */
export function validatePayloadEnvelope(rendered: string): boolean {
  const lines = rendered
    .trim()
    .split('\n')
    .map((line) => line.trimEnd());
  if (lines.length < 3) return false;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first.startsWith('BEGIN_PAYLOAD [') || !last.startsWith('END_PAYLOAD [')) {
    return false;
  }
  return (
    first.replace('BEGIN_PAYLOAD', '').trim() === last.replace('END_PAYLOAD', '').trim()
  );
}
