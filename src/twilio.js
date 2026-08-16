// Minimal Twilio SMS client using the REST API and global fetch (Node 18+).

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Send an SMS via Twilio's Messages API.
 * @param {string} to   Destination number in E.164 format (e.g. +15551234567).
 * @param {string} body Message text.
 * @returns {Promise<{sid: string, status: string, to: string}>}
 */
export async function sendSms(to, body) {
  const sid = requireEnv("TWILIO_SID");
  const auth = requireEnv("TWILIO_AUTH");
  const from = requireEnv("TWILIO_NUMBER");

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const authHeader = "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.message || res.statusText;
    throw new Error(`Twilio SMS failed (${res.status}): ${detail}`);
  }

  return { sid: data.sid, status: data.status, to: data.to };
}
