import { sidereal, solar, nutation, moonposition, julian } from "https://esm.sh/astronomia@4.0.0";

//////////////////////////////////////////////////
// TYPES
//////////////////////////////////////////////////

interface Shell {
  id: number;
  up: "UP" | "DN";
  pos: [number, number]; // [x, y] relative within house
}

interface CastResult {
  entropy_bits: number;
  arudha: number;
  question?: string;
  lang?: string;
  counts: { total_up: number; total_dn: number; };
  board: Record<number, Shell[]>;
  birth_context?: { lat: number; lon: number; time: string; };
  prasna_context?: { lat: number; lon: number; time: string; };
  janma_lagna?: { house: number; sign: string; degrees: number; };
  transit_planets?: Record<string, { house: number; degrees: number; }>;
  time_piles: { past: number; present: number; future: number; };
}

//////////////////////////////////////////////////
// ASTROLOGY ENGINE
//////////////////////////////////////////////////

function dateToJD(date: Date): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  let jd = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  jd += (hours - 12) / 24 + minutes / 1440 + seconds / 86400;
  return jd;
}

function getLahiriAyanamsa(jd: number): number {
  const t = (jd - 2451545.0) / 36525.0;
  return 22.466667 + 1.396667 * t + 0.000309 * t * t;
}

function longToHouse(long: number, ayanamsa: number): number {
  const siderealLong = (long - ayanamsa + 360) % 360;
  return Math.floor(siderealLong / 30) + 1;
}

function getRashiName(house: number): string {
  const rashis = ["Mesha", "Vrishabha", "Mithuna", "Karka", "Simha", "Kanya", "Thula", "Vrischika", "Dhanus", "Makara", "Kumbha", "Meena"];
  return rashis[house - 1];
}

async function calculateAstro(lat: number, lon: number, timeStr: string, isBirth: boolean) {
  const date = new Date(timeStr);
  const jd = dateToJD(date);
  const ayanamsa = getLahiriAyanamsa(jd);
  
  if (isBirth) {
    const gst = sidereal.apparent(jd);
    const lst = (gst + lon / 15 + 24) % 24;
    const ramc = lst * 15;
    const eps = nutation.obliquity(jd);
    const phiRad = lat * Math.PI / 180;
    const ramcRad = ramc * Math.PI / 180;
    const epsRad = eps * Math.PI / 180;
    const ascRad = Math.atan2(Math.cos(ramcRad), - (Math.sin(ramcRad) * Math.cos(epsRad) + Math.tan(phiRad) * Math.sin(epsRad)));
    let ascLong = (ascRad * 180 / Math.PI + 360) % 360;
    const house = longToHouse(ascLong, ayanamsa);
    return { lagna: { house, sign: getRashiName(house), degrees: (ascLong - ayanamsa + 360) % 360 } };
  } else {
    const planets: any = {};
    const sunL = solar.apparentLongitude(jd);
    planets["Sun"] = { house: longToHouse(sunL, ayanamsa), degrees: sunL };
    const moonPos = moonposition.position(jd);
    const moonL = moonPos.lon * 180 / Math.PI;
    planets["Moon"] = { house: longToHouse(moonL, ayanamsa), degrees: (moonL + 360) % 360 };
    
    const pList = ["Mars", "Mercury", "Jupiter", "Venus", "Saturn", "Rahu", "Ketu", "Uranus"];
    for(const p of pList) {
        const offset = (Math.sin(jd * (pList.indexOf(p) + 3)) * 180);
        const pos = (sunL + offset + 360) % 360;
        planets[p] = { house: longToHouse(pos, ayanamsa), degrees: pos };
    }
    return { planets };
  }
}

//////////////////////////////////////////////////
// CAST ENGINE
//////////////////////////////////////////////////

const encoder = new TextEncoder();
async function sha512(input: string): Promise<Uint8Array> {
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-512", data);
  return new Uint8Array(hash);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) result = (result << 8n) + BigInt(b);
  return result;
}

async function deriveEntropy(seed: string, tag: string): Promise<bigint> {
  return bytesToBigInt(await sha512(`${seed}:${tag}`));
}

async function simulateCast(rawBits: string, q?: string, lang?: string, birth?: any, prasna?: any): Promise<CastResult> {
  const seed = rawBits;
  const arudha = Number((await deriveEntropy(seed, "arudha")) % 12n) + 1;
  const board: Record<number, Shell[]> = {};
  for (let i = 1; i <= 12; i++) board[i] = [];

  let total_up = 0, total_dn = 0;
  for (let i = 0; i < 108; i++) {
    const e = await deriveEntropy(seed, `shell:${i}`);
    const house = Number((e >> 1n) % 12n) + 1;
    const isUp = (e & 1n) === 1n;
    if (isUp) total_up++; else total_dn++;
    
    // Spatial component: relative position within house (0-100)
    const px = Number((e >> 10n) % 100n);
    const py = Number((e >> 17n) % 100n);
    
    board[house].push({ id: i + 1, up: isUp ? "UP" : "DN", pos: [px, py] });
  }

  const pastCount = board[12].length + board[1].length + board[2].length;
  const presentCount = board[3].length + board[4].length + board[5].length + board[6].length;
  const futureCount = board[7].length + board[8].length + board[9].length + board[10].length + board[11].length;

  function getRem(c: number) { const r = c % 8; return r === 0 ? 8 : r; }

  let janma_lagna = undefined;
  if (birth && birth.lat) {
      const res = await calculateAstro(birth.lat, birth.lon, birth.time, true);
      janma_lagna = res.lagna;
  }

  let transit_planets = undefined;
  if (prasna && prasna.lat) {
      const res = await calculateAstro(prasna.lat, prasna.lon, prasna.time, false);
      transit_planets = res.planets;
  }

  return {
    entropy_bits: seed.length, arudha, question: q, lang, counts: { total_up, total_dn },
    board, janma_lagna, transit_planets,
    time_piles: { past: getRem(pastCount), present: getRem(presentCount), future: getRem(futureCount) }
  };
}

//////////////////////////////////////////////////
// AI INTERPRETATION
//////////////////////////////////////////////////

async function callAI(systemPrompt: string, userPrompt: string) {
  const KEY = Deno.env.get("DEEPSEEK_API_KEY") || Deno.env.get("GEMINI_API_KEY");
  const isDeepseek = !!Deno.env.get("DEEPSEEK_API_KEY");
  const res = await fetch(isDeepseek ? "https://api.deepseek.com/chat/completions" : `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(isDeepseek ? { "Authorization": `Bearer ${KEY}` } : {}) },
      body: JSON.stringify(isDeepseek ? {
          model: "deepseek-chat",
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
          response_format: { type: "json_object" }
      } : { contents: [{ parts: [{ text: systemPrompt + "\n" + userPrompt }] }] })
  });
  const data = await res.json();
  const text = isDeepseek ? data.choices?.[0]?.message?.content : data.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
}

//////////////////////////////////////////////////
// HTTP ROUTER
//////////////////////////////////////////////////

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const lang = body.lang || "en";

    if (url.pathname.includes("/cast")) {
        return new Response(JSON.stringify(await simulateCast(body.bits, body.q, body.lang, body.birth, body.prasna)), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (url.pathname.includes("/interpret/structure")) {
        const { cast, history } = body;
        const system = `You are a Vedic Jyotishi and technical expert in Ashtamangala Prasna. You MUST return JSON. Use ${lang}.
        
        Analyze the technical structure based on:
        1. Spatial distribution of shells (clusters, empty houses, orientation patterns).
        2. The 8-symbol time pile logic (1:Dhwaja, 2:Dhumra, 3:Simha, 4:Shwana, 5:Vrushabha, 6:Khara, 7:Gaja, 8:Dhwanksha).
        3. The interaction between Arudha, Janma Lagna (if present), and transit planets.
        4. Evolution from previous questions in this session memory.

        Schema: {
          "analysis_title": "string",
          "sections": [ { "title": "string", "technical_rishi": "string", "colloquial_modern": "string" } ],
          "concluding_insight": "string"
        }`;
        
        let historyStr = "";
        if (history && history.length > 0) {
            historyStr = "\n--- SESSION MEMORY (RECENT INQUIRIES) ---\n" + 
                history.map((h: any) => `
TIME: ${h.time_ago}
QUERY: ${h.question}
TECHNICAL ANALYSIS GIVEN: ${h.technical_summary || "N/A"}
FINAL PREDICTION GIVEN: ${h.spiritual_prediction || "N/A"}
------------------------------------------`).join("\n") + "\n";
        }

        const user = `Analyze: Question "${cast.question}", Cast: ${JSON.stringify(cast)}.${historyStr}`;
        return new Response(JSON.stringify(await callAI(system, user)), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (url.pathname.includes("/interpret/advice")) {
        const { cast, structure, history } = body;
        const system = `You are a Vedic Guru. You MUST return JSON. Use ${lang}.
        Schema: {
          "counsel_title": "string",
          "guidance_narrative": [ { "heading": "string", "content": "string" } ],
          "specific_remedies": [ "string" ],
          "final_prediction": "string"
        }`;

        let historyStr = "";
        if (history && history.length > 0) {
            historyStr = "\n--- SESSION MEMORY (RECENT INQUIRIES) ---\n" + 
                history.map((h: any) => `
TIME: ${h.time_ago}
QUERY: ${h.question}
TECHNICAL ANALYSIS GIVEN: ${h.technical_summary || "N/A"}
FINAL PREDICTION GIVEN: ${h.spiritual_prediction || "N/A"}
------------------------------------------`).join("\n") + "\n";
        }

        const user = `Advice for: "${cast.question}". Technical context: ${JSON.stringify(structure)}.${historyStr}`;
        return new Response(JSON.stringify(await callAI(system, user)), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response("Not Found", { status: 404 });
  } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: corsHeaders }); }
});
