import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

/**
 * The creator's cloned voice, through ElevenLabs: an instant voice clone made from a minute or two
 * of them talking, then text-to-speech in that voice for each voiceover line.
 */

const BASE = "https://api.elevenlabs.io/v1";

export const voiceCloningEnabled = () => Boolean(config.elevenlabs.key);

async function call(pathname: string, init: RequestInit): Promise<Response> {
  if (!config.elevenlabs.key) throw new Error("Voice cloning isn't set up: add ELEVENLABS_API_KEY on Render.");
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { "xi-api-key": config.elevenlabs.key, ...(init.headers as Record<string, string>) },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body.slice(0, 300);
    try {
      const d = JSON.parse(body)?.detail;
      msg = typeof d === "string" ? d : d?.message ?? msg;
    } catch {}
    if (res.status === 401) msg = `the API key was refused (${msg})`;
    throw new Error(`ElevenLabs: ${msg || res.statusText}`);
  }
  return res;
}

/** Make a voice from recorded samples; returns its id. */
export async function cloneVoice(name: string, samples: string[]): Promise<string> {
  const form = new FormData();
  form.append("name", name);
  form.append("description", "Voiceovers for Rollcut");
  form.append("remove_background_noise", "true");
  for (const file of samples) {
    form.append("files", new Blob([fs.readFileSync(file)], { type: "audio/mp4" }), path.basename(file));
  }
  const res = await call("/voices/add", { method: "POST", body: form });
  const { voice_id } = (await res.json()) as { voice_id?: string };
  if (!voice_id) throw new Error("ElevenLabs didn't return a voice.");
  return voice_id;
}

export async function deleteVoice(id: string): Promise<void> {
  await call(`/voices/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

/** Say `text` in the voice and save it (mp3) at `dest`. */
export async function speak(voiceId: string, text: string, dest: string): Promise<void> {
  const res = await call(`/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: config.elevenlabs.model,
      voice_settings: { stability: 0.45, similarity_boost: 0.85, style: 0.15, use_speaker_boost: true },
    }),
  });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
