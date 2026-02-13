import { sidereal, solar, nutation, moonposition, julian } from "https://esm.sh/astronomia@4.0.0";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

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
    
    // Correct way to get true obliquity in astronomia 4.x
    const meanEps = nutation.meanObliquity(jd);
    const [dPsi, dEps] = nutation.nutation(jd);
    const eps = meanEps + dEps;
    
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
// EXPORT FORMATTING
//////////////////////////////////////////////////

interface ExportData {
  cast: CastResult;
  structure: any;
  advice: any;
  format: 'markdown' | 'pdf' | 'html';
  lang: string;
  timestamp: string;
}

function formatDetailedContent(data: ExportData): string {
  const { cast, structure, advice, lang, timestamp } = data;
  
  // Enhance structure sections with more detail
  const enhancedSections = structure.sections?.map((section: any, index: number) => ({
    ...section,
    detailed_context: generateDetailedContext(section, cast, index),
    astrological_significance: getAstrologicalSignificance(section.title, cast)
  })) || [];
  
  // Enhance advice narrative with more detail
  const enhancedNarrative = advice.spiritual_guidance?.guidance_narrative?.map((item: any, index: number) => ({
    ...item,
    detailed_explanation: generateDetailedAdvice(item, cast, index),
    practical_application: getPracticalApplication(item.heading)
  })) || advice.guidance_narrative?.map((item: any, index: number) => ({
    ...item,
    detailed_explanation: generateDetailedAdvice(item, cast, index),
    practical_application: getPracticalApplication(item.heading)
  })) || [];
  
  return JSON.stringify({
    ...data,
    structure: {
      ...structure,
      sections: enhancedSections
    },
    advice: {
      ...advice,
      spiritual_guidance: {
        ...advice.spiritual_guidance,
        guidance_narrative: enhancedNarrative
      }
    }
  });
}

function generateDetailedContext(section: any, cast: CastResult, index: number): string {
  const contexts = [
    `The ${section.title} reveals intricate patterns within the Ashtamangala board. With ${cast.counts.total_up} upright shells and ${cast.counts.total_dn} reversed shells, the distribution suggests ${cast.counts.total_up > cast.counts.total_dn ? 'ascending energy favoring manifestation' : 'descending energy requiring introspection'}. The Arudha Lagna in House ${cast.arudha} indicates ${getArudhaSignificance(cast.arudha)}.`,
    `Examining the spatial configuration, we observe the interplay between planetary transits and shell positions. ${cast.janma_lagna ? `The Janma Lagna at ${cast.janma_lagna.sign} provides the foundational karmic context, suggesting ${getLagnaSignificance(cast.janma_lagna.sign)}.` : 'Without birth data, we focus purely on the Prasna moment, which offers immediate clarity on the present query.'}`,
    `The time piles (Past: ${cast.time_piles.past}, Present: ${cast.time_piles.present}, Future: ${cast.time_piles.future}) form a temporal triad that maps the evolutionary trajectory of this inquiry. This temporal signature suggests ${getTimePileInterpretation(cast.time_piles)}.`
  ];
  return contexts[index % contexts.length];
}

function generateDetailedAdvice(item: any, cast: CastResult, index: number): string {
  return `This guidance emerges from the convergence of planetary energies at the moment of inquiry. ${item.content} When considering the shell distribution across all twelve houses, particularly the emphasis on House ${cast.arudha} as the Arudha, the wisdom here suggests a path of ${cast.counts.total_up > cast.counts.total_dn ? 'active engagement and forward movement' : 'patience, reflection, and strategic waiting'}. The ${cast.transit_planets ? `planetary configuration, with key planets positioned in specific houses,` : 'celestial patterns at this moment'} support this interpretation.`;
}

function getAstrologicalSignificance(title: string, cast: CastResult): string {
  const significances: Record<string, string> = {
    "Celestial Structure": "The architectural blueprint of cosmic energies at this moment",
    "Planetary Configuration": `Active planetary placements ${cast.transit_planets ? Object.keys(cast.transit_planets).join(', ') : 'influencing the houses'}`,
    "Karmic Patterns": "The imprint of past actions meeting present opportunities",
    "Temporal Flow": "The movement of time as revealed through shell distribution",
    "Sacred Geometry": "The mathematical harmony underlying the material manifestation"
  };
  return significances[title] || "The deeper symbolic meaning embedded in this configuration";
}

function getPracticalApplication(heading: string): string {
  const applications: Record<string, string> = {
    "Divine Timing": "Schedule important actions during favorable temporal windows",
    "Karmic Remedies": "Engage in specific spiritual practices to balance energies",
    "Mundane Actions": "Practical steps to take in the material world",
    "Spiritual Practices": "Meditation, mantra, and ritual recommendations",
    "Strategic Guidance": "How to approach challenges and opportunities"
  };
  return applications[heading] || "Apply this wisdom through mindful awareness and appropriate action";
}

function getArudhaSignificance(house: number): string {
  const significances: Record<number, string> = {
    1: "self-identity and personal projection becoming visible",
    2: "resources, values, and speech gaining prominence",
    3: "courage, communication, and initiative coming to the fore",
    4: "home, emotions, and foundations becoming central",
    5: "creativity, intelligence, and past merits manifesting",
    6: "service, challenges, and health matters highlighted",
    7: "relationships, partnerships, and external dealings emphasized",
    8: "transformation, hidden matters, and longevity activated",
    9: "fortune, wisdom, and higher learning illuminated",
    10: "career, status, and public standing in focus",
    11: "gains, aspirations, and social networks prominent",
    12: "spirituality, losses, and liberation themes emerging"
  };
  return significances[house] || "karmic themes becoming manifest";
}

function getLagnaSignificance(sign: string): string {
  return `the soul's journey through the realm of ${sign}, with all its inherent strengths and challenges`;
}

function getTimePileInterpretation(piles: { past: number; present: number; future: number }): string {
  const symbols = ["", "Dhwaja (Victory)", "Dhumra (Obscurity)", "Simha (Power)", "Shwana (Service)", "Vrushabha (Stability)", "Khara (Adversity)", "Gaja (Prosperity)", "Dhwanksha (Decay)"];
  return `a trajectory from ${symbols[piles.past]} through ${symbols[piles.present]} toward ${symbols[piles.future]}`;
}

function generateMarkdown(data: ExportData): string {
  const { cast, structure, advice, lang, timestamp } = data;
  const t = getI18N(lang);
  
  let md = `# ${t.exportTitle || 'Rishi Ashtamangala Prasna Reading'}\n\n`;
  md += `**${t.date || 'Date'}:** ${timestamp}\n`;
  md += `**${t.language || 'Language'}:** ${lang.toUpperCase()}\n\n`;
  
  // Query Section
  md += `## ${t.query || 'Sacred Query'}\n\n`;
  md += `> ${cast.question || t.generalReading || 'General Reading'}\n\n`;
  
  // Technical Cast Details
  md += `## ${t.technicalDetails || 'Technical Cast Details'}\n\n`;
  md += `### ${t.shellDistribution || 'Shell Distribution'}\n`;
  md += `- **${t.upright || 'Upright'}:** ${cast.counts.total_up}\n`;
  md += `- **${t.reversed || 'Reversed'}:** ${cast.counts.total_dn}\n`;
  md += `- **${t.arudha || 'Arudha Lagna'}:** House ${cast.arudha}\n`;
  
  if (cast.janma_lagna) {
    md += `- **${t.janmaLagna || 'Janma Lagna'}:** ${cast.janma_lagna.sign} (${cast.janma_lagna.degrees.toFixed(2)}°)\n`;
  }
  
  md += `\n### ${t.timePiles || 'Time Piles'}\n`;
  md += `- **${t.past || 'Past'}:** ${cast.time_piles.past}\n`;
  md += `- **${t.present || 'Present'}:** ${cast.time_piles.present}\n`;
  md += `- **${t.future || 'Future'}:** ${cast.time_piles.future}\n\n`;
  
  if (cast.transit_planets && Object.keys(cast.transit_planets).length > 0) {
    md += `### ${t.planetaryPositions || 'Planetary Positions'}\n\n`;
    md += `| ${t.planet || 'Planet'} | ${t.house || 'House'} | ${t.degrees || 'Degrees'} |\n`;
    md += `|----------|-------|---------|\n`;
    Object.entries(cast.transit_planets).forEach(([planet, data]: [string, any]) => {
      md += `| ${planet} | ${data.house} | ${data.degrees.toFixed(2)}° |\n`;
    });
    md += `\n`;
  }
  
  // Structure Analysis
  md += `---\n\n`;
  md += `# ${structure.analysis_title || t.celestialStructure || 'Celestial Structure'}\n\n`;
  
  structure.sections?.forEach((section: any, index: number) => {
    md += `## ${index + 1}. ${section.title}\n\n`;
    md += `### ${t.technicalPerspective || 'Technical Perspective'}\n\n`;
    md += `${section.technical_rishi || section.technical}\n\n`;
    md += `**${t.astrologicalSignificance || 'Astrological Significance'}:** ${getAstrologicalSignificance(section.title, cast)}\n\n`;
    md += `*${t.detailedContext || 'Detailed Context'}:* ${generateDetailedContext(section, cast, index)}\n\n`;
    md += `### ${t.modernInterpretation || 'Modern Interpretation'}\n\n`;
    md += `${section.colloquial_modern || section.colloquial}\n\n`;
    md += `---\n\n`;
  });
  
  if (structure.concluding_insight) {
    md += `## ${t.concludingInsight || 'Concluding Insight'}\n\n`;
    md += `> ${structure.concluding_insight}\n\n`;
  }
  
  // Spiritual Guidance
  const guidance = advice.spiritual_guidance || advice;
  md += `---\n\n`;
  md += `# ${guidance.counsel_title || t.spiritualGuidance || 'Spiritual Guidance'}\n\n`;
  
  const narrative = guidance.guidance_narrative || guidance.narrative_sections || [];
  narrative.forEach((item: any, index: number) => {
    md += `## ${index + 1}. ${item.heading || item.title}\n\n`;
    md += `${item.content || item.body}\n\n`;
    md += `*${t.deeperWisdom || 'Deeper Wisdom'}:* ${generateDetailedAdvice(item, cast, index)}\n\n`;
    md += `**${t.practicalApplication || 'Practical Application'}:** ${getPracticalApplication(item.heading || item.title)}\n\n`;
    md += `---\n\n`;
  });
  
  // Remedies
  const remedies = guidance.specific_remedies || [];
  if (remedies.length > 0) {
    md += `## ${t.sacredRemedies || 'Sacred Remedies'}\n\n`;
    remedies.forEach((remedy: string, index: number) => {
      md += `${index + 1}. ${remedy}\n`;
    });
    md += `\n---\n\n`;
  }
  
  // Final Prediction
  if (guidance.final_prediction) {
    md += `## ${t.finalPrediction || 'Final Prediction'}\n\n`;
    md += `> ${guidance.final_prediction}\n\n`;
  }
  
  // Footer
  md += `---\n\n`;
  md += `*${t.generatedBy || 'Generated by Rishi Ashtamangala Prasna'}*\n`;
  md += `*${t.sacredWisdom || 'May the wisdom of the ancients guide your path'}*\n`;
  
  return md;
}

function generateHTML(data: ExportData): string {
  const md = generateMarkdown(data);
  // Simple markdown to HTML conversion
  let html = md
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>')
    .replace(/\|(.*)\|/g, '<tr><td>$1</td></tr>')
    .replace(/^(\d+)\. (.*$)/gm, '<li>$2</li>')
    .replace(/---/g, '<hr>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  
  return `<!DOCTYPE html>
<html lang="${data.lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rishi Ashtamangala Prasna Reading</title>
  <style>
    body { font-family: 'Palatino', 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; background: #faf8f5; color: #333; line-height: 1.8; }
    h1 { color: #8b4513; border-bottom: 3px solid #d4af37; padding-bottom: 10px; }
    h2 { color: #a0522d; margin-top: 30px; }
    h3 { color: #cd853f; }
    blockquote { border-left: 4px solid #d4af37; padding-left: 20px; margin: 20px 0; font-style: italic; color: #666; }
    hr { border: none; border-top: 1px solid #d4af37; margin: 30px 0; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    td { padding: 10px; border: 1px solid #ddd; }
    li { margin: 10px 0; }
    strong { color: #8b4513; }
    em { color: #666; }
  </style>
</head>
<body>
  ${html}
</body>
</html>`;
}

function getI18N(lang: string): Record<string, string> {
  const i18n: Record<string, Record<string, string>> = {
    en: {
      exportTitle: "Rishi Ashtamangala Prasna Reading",
      date: "Date",
      language: "Language",
      query: "Sacred Query",
      generalReading: "General Reading",
      technicalDetails: "Technical Cast Details",
      shellDistribution: "Shell Distribution",
      upright: "Upright",
      reversed: "Reversed",
      arudha: "Arudha Lagna",
      janmaLagna: "Janma Lagna",
      timePiles: "Time Piles",
      past: "Past",
      present: "Present",
      future: "Future",
      planetaryPositions: "Planetary Positions",
      planet: "Planet",
      house: "House",
      degrees: "Degrees",
      celestialStructure: "Celestial Structure",
      technicalPerspective: "Technical Perspective",
      astrologicalSignificance: "Astrological Significance",
      detailedContext: "Detailed Context",
      modernInterpretation: "Modern Interpretation",
      concludingInsight: "Concluding Insight",
      spiritualGuidance: "Spiritual Guidance",
      deeperWisdom: "Deeper Wisdom",
      practicalApplication: "Practical Application",
      sacredRemedies: "Sacred Remedies",
      finalPrediction: "Final Prediction",
      generatedBy: "Generated by Rishi Ashtamangala Prasna",
      sacredWisdom: "May the wisdom of the ancients guide your path"
    },
    es: {
      exportTitle: "Lectura de Prasna Ashtamangala Rishi",
      date: "Fecha",
      language: "Idioma",
      query: "Consulta Sagrada",
      generalReading: "Lectura General",
      technicalDetails: "Detalles Técnicos del Lanzamiento",
      shellDistribution: "Distribución de Conchas",
      upright: "Derecho",
      reversed: "Invertido",
      arudha: "Lagna Arudha",
      janmaLagna: "Lagna de Nacimiento",
      timePiles: "Pilas Temporales",
      past: "Pasado",
      present: "Presente",
      future: "Futuro",
      planetaryPositions: "Posiciones Planetarias",
      planet: "Planeta",
      house: "Casa",
      degrees: "Grados",
      celestialStructure: "Estructura Celestial",
      technicalPerspective: "Perspectiva Técnica",
      astrologicalSignificance: "Significado Astrológico",
      detailedContext: "Contexto Detallado",
      modernInterpretation: "Interpretación Moderna",
      concludingInsight: "Visión Conclusiva",
      spiritualGuidance: "Guía Espiritual",
      deeperWisdom: "Sabiduría Profunda",
      practicalApplication: "Aplicación Práctica",
      sacredRemedies: "Remedios Sagrados",
      finalPrediction: "Predicción Final",
      generatedBy: "Generado por Rishi Ashtamangala Prasna",
      sacredWisdom: "Que la sabiduría de los ancestros guíe tu camino"
    },
    it: {
      exportTitle: "Lettura Prasna Ashtamangala Rishi",
      date: "Data",
      language: "Lingua",
      query: "Domanda Sacra",
      generalReading: "Lettura Generale",
      technicalDetails: "Dettagli Tecnici del Lancio",
      shellDistribution: "Distribuzione delle Conchiglie",
      upright: "Dritto",
      reversed: "Rovescio",
      arudha: "Lagna Arudha",
      janmaLagna: "Lagna di Nascita",
      timePiles: "Pile Temporali",
      past: "Passato",
      present: "Presente",
      future: "Futuro",
      planetaryPositions: "Posizioni Planetarie",
      planet: "Pianeta",
      house: "Casa",
      degrees: "Gradi",
      celestialStructure: "Struttura Celeste",
      technicalPerspective: "Prospettiva Tecnica",
      astrologicalSignificance: "Significato Astrologico",
      detailedContext: "Contesto Dettagliato",
      modernInterpretation: "Interpretazione Moderna",
      concludingInsight: "Visione Conclusiva",
      spiritualGuidance: "Guida Spirituale",
      deeperWisdom: "Saggezza Profonda",
      practicalApplication: "Applicazione Pratica",
      sacredRemedies: "Rimedi Sacri",
      finalPrediction: "Predizione Finale",
      generatedBy: "Generato da Rishi Ashtamangala Prasna",
      sacredWisdom: "Che la saggezza degli antichi guidi il tuo cammino"
    }
  };
  return i18n[lang] || i18n.en;
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

async function translateContent(content: any, targetLang: string, type: string) {
  const KEY = Deno.env.get("DEEPSEEK_API_KEY") || Deno.env.get("GEMINI_API_KEY");
  const isDeepseek = !!Deno.env.get("DEEPSEEK_API_KEY");
  
  const systemPrompt = `You are a professional translator specializing in spiritual and astrological texts. Translate the following JSON content to ${targetLang}. 
Maintain the exact JSON structure. Preserve all technical terminology accurately. Keep the spiritual and poetic tone. 
Only translate the text values, never the keys. Return valid JSON only.`;

  const userPrompt = `Translate this ${type} content to ${targetLang}:\n${JSON.stringify(content, null, 2)}`;

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
// PDF GENERATION
//////////////////////////////////////////////////

// Sanitize text for PDF (remove Unicode characters that WinAnsi can't encode)
function sanitizeForPDF(text: string): string {
  if (!text) return '';
  return text
    // Replace arrows
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/↑/g, '^')
    .replace(/↓/g, 'v')
    // Replace common spiritual symbols
    .replace(/ॐ/g, 'OM')
    // Replace emojis and symbols
    .replace(/🙏/g, '(Namaste)')
    .replace(/📄/g, '[DOC]')
    .replace(/✨/g, '*')
    .replace(/🔮/g, '[Crystal]')
    .replace(/📍/g, '[Loc]')
    .replace(/📝/g, '[Note]')
    .replace(/🌐/g, '[Web]')
    .replace(/📖/g, '[Book]')
    // Replace smart quotes
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // Replace other common Unicode
    .replace(/–/g, '-')
    .replace(/—/g, '--')
    .replace(/…/g, '...')
    .replace(/©/g, '(C)')
    .replace(/®/g, '(R)')
    .replace(/™/g, '(TM)')
    // Keep characters that are supported by WinAnsi (includes common accents)
    // ASCII (0-127) and Latin-1 (128-255)
    .replace(/[^\x00-\xFF]/g, '');
}

async function generatePDF(data: ExportData): Promise<Uint8Array> {
  const { cast, structure, advice, lang, timestamp } = data;
  const t = getI18N(lang);
  
  // Create a new PDF document
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helveticaOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
  
  // Define colors
  const goldColor = rgb(0.84, 0.58, 0.29);  // #d69449 (Temple Gold)
  const darkBrown = rgb(0.41, 0.23, 0.13);   // #693b22 (Sandalwood)
  const textColor = rgb(0.11, 0.09, 0.08);     // #1b1715 (Ink)
  const lightGray = rgb(0.68, 0.65, 0.64);      // #ada7a3 (Stone)
  const jadeColor = rgb(0.31, 0.46, 0.33);   // #4f7653 (Jade)
  
  let currentPage = pdfDoc.addPage([612, 792]); // Letter size
  let y = 750;
  const margin = 50;
  const pageWidth = 612;
  const contentWidth = pageWidth - (margin * 2);
  
  // Helper function to add text (with sanitization)
  function addText(text: string, size: number, font: any, color: any, x: number, yPos: number): number {
    const sanitized = sanitizeForPDF(text);
    if (sanitized) {
      currentPage.drawText(sanitized, { x, y: yPos, size, font, color });
    }
    return yPos - size - 2;
  }
  
  // Helper function to add wrapped text (with sanitization)
  function addWrappedText(text: string, size: number, font: any, color: any, x: number, yPos: number, maxWidth: number): number {
    const sanitized = sanitizeForPDF(text);
    if (!sanitized) return yPos;
    
    const words = sanitized.split(' ');
    let line = '';
    let currentY = yPos;
    
    for (const word of words) {
      const testLine = line + (line ? ' ' : '') + word;
      const width = font.widthOfTextAtSize(testLine, size);
      
      if (width > maxWidth && line) {
        currentPage.drawText(line, { x, y: currentY, size, font, color });
        currentY -= size + 4;
        line = word;
      } else {
        line = testLine;
      }
    }
    
    if (line) {
      currentPage.drawText(line, { x, y: currentY, size, font, color });
      currentY -= size + 4;
    }
    
    return currentY;
  }
  
  // Helper function to check if we need a new page
  function checkNewPage(requiredSpace: number): void {
    if (y < requiredSpace + margin) {
      currentPage = pdfDoc.addPage([612, 792]);
      y = 750;
    }
  }
  
  // Title
  y = addText(t.exportTitle, 24, helveticaBold, jadeColor, margin, y);
  y -= 10;
  
  // Date and Language
  y = addText(`${t.date}: ${new Date(timestamp).toLocaleString()}`, 10, helvetica, lightGray, margin, y);
  y = addText(`${t.language}: ${lang.toUpperCase()}`, 10, helvetica, lightGray, margin, y);
  y -= 15;
  
  // Query Section
  y = addText(t.query.toUpperCase(), 14, helveticaBold, goldColor, margin, y);
  y -= 5;
  y = addWrappedText(`"${cast.question || t.generalReading}"`, 11, helveticaOblique, textColor, margin, y, contentWidth);
  y -= 20;
  
  // Technical Details Section
  checkNewPage(100);
  y = addText(t.technicalDetails.toUpperCase(), 14, helveticaBold, goldColor, margin, y);
  y -= 10;
  
  y = addText(`${t.shellDistribution}:`, 11, helveticaBold, textColor, margin, y);
  y = addText(`  ${t.upright}: ${cast.counts.total_up}`, 10, helvetica, textColor, margin + 10, y);
  y = addText(`  ${t.reversed}: ${cast.counts.total_dn}`, 10, helvetica, textColor, margin + 10, y);
  y = addText(`  ${t.arudha}: House ${cast.arudha}`, 10, helvetica, textColor, margin + 10, y);
  
  if (cast.janma_lagna) {
    y = addText(`  ${t.janmaLagna}: ${cast.janma_lagna.sign} (${cast.janma_lagna.degrees.toFixed(2)}°)`, 10, helvetica, textColor, margin + 10, y);
  }
  y -= 10;
  
  y = addText(`${t.timePiles}:`, 11, helveticaBold, textColor, margin, y);
  y = addText(`  ${t.past}: ${cast.time_piles.past} | ${t.present}: ${cast.time_piles.present} | ${t.future}: ${cast.time_piles.future}`, 10, helvetica, textColor, margin + 10, y);
  y -= 20;
  
  // Planetary Positions
  if (cast.transit_planets && Object.keys(cast.transit_planets).length > 0) {
    checkNewPage(100);
    y = addText(t.planetaryPositions.toUpperCase(), 14, helveticaBold, goldColor, margin, y);
    y -= 5;
    
    y = addText(`${t.planet.padEnd(12)} ${t.house.padEnd(8)} ${t.degrees}`, 10, helveticaBold, darkBrown, margin, y);
    y -= 5;
    
    Object.entries(cast.transit_planets).forEach(([planet, data]: [string, any]) => {
      y = addText(`${planet.padEnd(12)} ${String(data.house).padEnd(8)} ${data.degrees.toFixed(2)}°`, 9, helvetica, textColor, margin, y);
    });
    y -= 20;
  }
  
  // Structure Analysis Section
  checkNewPage(100);
  y = addText((structure.analysis_title || t.celestialStructure).toUpperCase(), 16, helveticaBold, darkBrown, margin, y);
  y -= 15;
  
  structure.sections?.forEach((section: any, index: number) => {
    checkNewPage(150);
    y = addText(`${index + 1}. ${section.title}`, 13, helveticaBold, goldColor, margin, y);
    y -= 8;
    
    // Technical perspective
    y = addText(t.technicalPerspective + ':', 10, helveticaBold, darkBrown, margin, y);
    const technicalText = section.technical_rishi || section.technical;
    if (technicalText) {
      y = addWrappedText(technicalText, 9, helvetica, textColor, margin + 10, y, contentWidth - 20);
    }
    y -= 8;
    
    // Astrological significance
    const significance = getAstrologicalSignificance(section.title, cast);
    y = addText(`${t.astrologicalSignificance}:`, 9, helveticaBold, darkBrown, margin, y);
    y = addWrappedText(significance, 8, helveticaOblique, lightGray, margin + 10, y, contentWidth - 20);
    y -= 8;
    
    // Detailed context
    const context = generateDetailedContext(section, cast, index);
    y = addText(`${t.detailedContext}:`, 9, helveticaBold, darkBrown, margin, y);
    y = addWrappedText(context, 8, helveticaOblique, lightGray, margin + 10, y, contentWidth - 20);
    y -= 10;
    
    // Modern interpretation
    y = addText(t.modernInterpretation + ':', 10, helveticaBold, darkBrown, margin, y);
    const modernText = section.colloquial_modern || section.colloquial;
    if (modernText) {
      y = addWrappedText(modernText, 9, helvetica, textColor, margin + 10, y, contentWidth - 20);
    }
    y -= 20;
  });
  
  // Concluding insight
  if (structure.concluding_insight) {
    checkNewPage(100);
    y = addText(t.concludingInsight.toUpperCase(), 14, helveticaBold, goldColor, margin, y);
    y -= 5;
    y = addWrappedText(structure.concluding_insight, 10, helveticaOblique, darkBrown, margin, y, contentWidth);
    y -= 20;
  }
  
  // Spiritual Guidance Section
  const guidance = advice.spiritual_guidance || advice;
  checkNewPage(100);
  y = addText((guidance.counsel_title || t.spiritualGuidance).toUpperCase(), 16, helveticaBold, darkBrown, margin, y);
  y -= 15;
  
  const narrative = guidance.guidance_narrative || guidance.narrative_sections || [];
  narrative.forEach((item: any, index: number) => {
    checkNewPage(150);
    y = addText(`${index + 1}. ${item.heading || item.title}`, 13, helveticaBold, goldColor, margin, y);
    y -= 8;
    
    // Content
    const content = item.content || item.body;
    if (content) {
      y = addWrappedText(content, 9, helvetica, textColor, margin, y, contentWidth);
    }
    y -= 8;
    
    // Deeper wisdom
    const wisdom = generateDetailedAdvice(item, cast, index);
    y = addText(`${t.deeperWisdom}:`, 9, helveticaBold, darkBrown, margin, y);
    y = addWrappedText(wisdom, 8, helveticaOblique, lightGray, margin + 10, y, contentWidth - 20);
    y -= 8;
    
    // Practical application
    const application = getPracticalApplication(item.heading || item.title);
    y = addText(`${t.practicalApplication}:`, 9, helveticaBold, darkBrown, margin, y);
    y = addWrappedText(application, 8, helveticaOblique, lightGray, margin + 10, y, contentWidth - 20);
    y -= 20;
  });
  
  // Remedies
  const remedies = guidance.specific_remedies || [];
  if (remedies.length > 0) {
    checkNewPage(100);
    y = addText(t.sacredRemedies.toUpperCase(), 14, helveticaBold, goldColor, margin, y);
    y -= 5;
    
    remedies.forEach((remedy: string, index: number) => {
      y = addText(`${index + 1}. ${remedy}`, 10, helvetica, textColor, margin, y);
    });
    y -= 20;
  }
  
  // Final Prediction
  if (guidance.final_prediction) {
    checkNewPage(100);
    y = addText(t.finalPrediction.toUpperCase(), 14, helveticaBold, goldColor, margin, y);
    y -= 5;
    y = addWrappedText(guidance.final_prediction, 11, helveticaBold, darkBrown, margin, y, contentWidth);
    y -= 30;
  }
  
  // Footer on last page
  checkNewPage(50);
  y -= 20;
  y = addText(t.generatedBy, 8, helveticaOblique, lightGray, margin, y);
  y = addText(t.sacredWisdom, 9, helveticaOblique, goldColor, margin, y);
  
  // Generate PDF bytes
  return await pdfDoc.save();
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

    if (url.pathname.includes("/translate")) {
        const { content, targetLang, type } = body;
        const translated = await translateContent(content, targetLang, type);
        return new Response(JSON.stringify(translated), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (url.pathname.includes("/interpret/structure")) {
        const { cast, history } = body;
        const requestLang = body.lang || lang;
        const system = `You are a Vedic Jyotishi and technical expert in Ashtamangala Prasna. You MUST return JSON. Use ${requestLang}.
        
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
        const requestLang = body.lang || lang;
        const system = `You are a Vedic Guru. You MUST return JSON. Use ${requestLang}.
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

    if (url.pathname.includes("/export")) {
        const { cast, structure, advice, format = 'markdown', detailed = true } = body;
        const requestLang = body.lang || lang;
        const timestamp = new Date().toISOString();
        
        const exportData: ExportData = {
            cast,
            structure,
            advice,
            format: format as 'markdown' | 'pdf' | 'html',
            lang: requestLang,
            timestamp
        };
        
        // Enhance content with detailed context if requested
        if (detailed) {
            const detailedContent = formatDetailedContent(exportData);
            const parsed = JSON.parse(detailedContent);
            exportData.structure = parsed.structure;
            exportData.advice = parsed.advice;
        }
        
        let content: string;
        let contentType: string;
        let filename: string;
        const safeQuestion = (cast.question || 'reading').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
        
        switch (format) {
            case 'html':
                content = generateHTML(exportData);
                contentType = 'text/html';
                filename = `Ashtamangala_${safeQuestion}_${Date.now()}.html`;
                break;
            case 'pdf':
                // Generate actual PDF using pdf-lib
                const pdfBytes = await generatePDF(exportData);
                return new Response(pdfBytes, {
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "application/pdf",
                        "Content-Disposition": `attachment; filename="Ashtamangala_${safeQuestion}_${Date.now()}.pdf"`
                    }
                });
            case 'markdown':
            default:
                content = generateMarkdown(exportData);
                contentType = 'text/markdown';
                filename = `Ashtamangala_${safeQuestion}_${Date.now()}.md`;
                break;
        }
        
        return new Response(content, {
            headers: {
                ...corsHeaders,
                "Content-Type": contentType,
                "Content-Disposition": `attachment; filename="${filename}"`
            }
        });
    }

    return new Response("Not Found", { status: 404 });
  } catch (e: any) { return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: corsHeaders }); }
});
