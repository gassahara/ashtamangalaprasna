//////////////////////////////////////////////////
// LOCAL RESOURCES EDGE FUNCTION
// Provides localized search suggestions for remedies
// Converts lat/lng to place names, translates Sanskrit materials
//////////////////////////////////////////////////

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// Sanskrit → Local translations for common materials
const materialTranslations: Record<string, Record<string, { local: string; search_terms: string[] }>> = {
  en: {
    "Akshata": { local: "Rice grains mixed with turmeric", search_terms: ["akshata rice turmeric", "pooja rice yellow"] },
    "Kumkum": { local: "Vermilion red powder", search_terms: ["kumkum powder", "vermilion red powder", "pooja sindoor"] },
    "Chandan": { local: "Sandalwood paste or powder", search_terms: ["sandalwood paste", "chandan powder", "pooja sandal"] },
    "Ghee": { local: "Clarified butter", search_terms: ["pure ghee", "cow ghee", "clarified butter organic"] },
    "Pushpa": { local: "Fresh flowers", search_terms: ["fresh flowers", "puja flowers", "marigold jasmine roses"] },
    "Patra": { local: "Sacred leaves or betel leaf", search_terms: ["betel leaf paan", "sacred leaves pooja"] },
    "Dhoop": { local: "Incense", search_terms: ["dhoop incense", "sambrani", "loban"] },
    "Deepa": { local: "Oil lamp", search_terms: ["brass oil lamp", "diya deepam", "pooja lamp"] },
    "Rudraksha": { local: "Rudraksha beads", search_terms: ["rudraksha mala", "rudraksha beads authentic", "panchmukhi rudraksha"] },
    "Tulasi": { local: "Holy basil leaves", search_terms: ["tulasi plant", "holy basil fresh", "tulsi leaves"] },
    "Belapatra": { local: "Bilva leaves", search_terms: ["bel patra", "bilva leaves", "bael leaves shiva"] },
    "Durva": { local: "Bermuda grass", search_terms: ["durva grass", "garika doob grass", "ganesha grass"] },
    "Sindoor": { local: "Vermilion", search_terms: ["sindoor powder", "kumkum vermilion", "pooja red powder"] },
    "Panchamrita": { local: "Five nectars mixture", search_terms: ["panchamrita", "panchamrit honey ghee milk"] },
    "Kalasha": { local: "Sacred pot/copper vessel", search_terms: ["pooja kalash", "copper pot ceremony", "kalasha brass"] },
    "Darbha": { local: "Sacred grass", search_terms: ["darbha grass", "kusa grass pooja", "pavitram"] }
  },
  es: {
    "Akshata": { local: "Arroz con cúrcuma", search_terms: ["arroz cúrcuma pooja", "akshata puja"] },
    "Kumkum": { local: "Polvo bermellón", search_terms: ["kumkum polvo", "bermellón hindú", "sindoor polvo"] },
    "Chandan": { local: "Sándalo pasta/polvo", search_terms: ["pasta sándalo", "chandan polvo", "sándalo pooja"] },
    "Ghee": { local: "Mantequilla clarificada", search_terms: ["ghee mantequilla clarificada", "ghee orgánico"] },
    "Pushpa": { local: "Flores frescas", search_terms: ["flores frescas", "flores pooja", "caléndula jazmín"] },
    "Patra": { local: "Hojas sagradas", search_terms: ["hoja betel", "paan hojas", "hojas sagradas pooja"] },
    "Dhoop": { local: "Incienso", search_terms: ["inciensos dhoop", "sambrani incienso"] },
    "Deepa": { local: "Lámpara de aceite", search_terms: ["lámpara aceite latón", "diya lámpara"] },
    "Rudraksha": { local: "Cuentas de Rudraksha", search_terms: ["rudraksha mala", "cuentas rudraksha"] },
    "Tulasi": { local: "Albahaca sagrada", search_terms: ["tulasi planta", "albahaca santa fresca"] },
    "Belapatra": { local: "Hojas de Bilva", search_terms: ["bel patra", "hojas bilva shiva"] },
    "Durva": { local: "Grama Bermuda", search_terms: ["durva hierba", "hierba ganesha"] },
    "Sindoor": { local: "Bermellón", search_terms: ["sindoor polvo", "kumkum bermellón"] },
    "Panchamrita": { local: "Mezcla de cinco néctares", search_terms: ["panchamrita", "panchamrit miel"] },
    "Kalasha": { local: "Vasija sagrada/cobre", search_terms: ["kalash pooja", "vasija cobre ceremonia"] },
    "Darbha": { local: "Hierba sagrada", search_terms: ["darbha hierba", "kusa hierba pooja"] }
  },
  it: {
    "Akshata": { local: "Riso con curcuma", search_terms: ["riso curcuma pooja", "akshata puja"] },
    "Kumkum": { local: "Polvere vermiglio", search_terms: ["kumkum polvere", "vermiglio indù", "sindoor"] },
    "Chandan": { local: "Pasta/polvere di sandalo", search_terms: ["pasta sandalo", "chandan polvere"] },
    "Ghee": { local: "Burro chiarificato", search_terms: ["ghee burro chiarificato", "ghee biologico"] },
    "Pushpa": { local: "Fiori freschi", search_terms: ["fiori freschi", "fiori pooja", "calendula gelsomino"] },
    "Patra": { local: "Foglie sacre", search_terms: ["foglie betel", "paan foglie", "foglie sacre pooja"] },
    "Dhoop": { local: "Incenso", search_terms: ["incenso dhoop", "sambrani incenso"] },
    "Deepa": { local: "Lampada ad olio", search_terms: ["lampada olio ottone", "diya lampada"] },
    "Rudraksha": { local: "Grani di Rudraksha", search_terms: ["rudraksha mala", "grani rudraksha"] },
    "Tulasi": { local: "Basilico sacro", search_terms: ["tulasi pianta", "basilico sacro fresco"] },
    "Belapatra": { local: "Foglie di Bilva", search_terms: ["bel patra", "foglie bilva shiva"] },
    "Durva": { local: "Erba Bermuda", search_terms: ["durva erba", "erba ganesha"] },
    "Sindoor": { local: "Vermiglio", search_terms: ["sindoor polvere", "kumkum vermiglio"] },
    "Panchamrita": { local: "Miscela di cinque nettari", search_terms: ["panchamrita", "panchamrit miele"] },
    "Kalasha": { local: "Vaso sacco/rame", search_terms: ["kalash pooja", "vaso rame cerimonia"] },
    "Darbha": { local: "Erba sacra", search_terms: ["darbha erba", "kusa erba pooja"] }
  }
};

// Reverse geocode using OpenStreetMap Nominatim
async function reverseGeocode(lat: number, lng: number): Promise<{ city: string; province: string; country: string; display: string }> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, {
      headers: { "User-Agent": "RishiAshtamangala/1.0" }
    });
    const data = await res.json();
    
    const address = data.address || {};
    const city = address.city || address.town || address.village || address.municipality || address.county || "Unknown";
    const province = address.state || address.region || address.county || "";
    const country = address.country || "";
    
    return {
      city,
      province,
      country,
      display: data.display_name || `${city}, ${province}, ${country}`.replace(/, ,/g, ',').replace(/, $/, '')
    };
  } catch (e) {
    return { city: "Unknown", province: "", country: "", display: `${lat.toFixed(4)}, ${lng.toFixed(4)}` };
  }
}

// Build search suggestions based on remedy type and materials
function buildSearchSuggestions(
  location: { city: string; province: string; country: string; display: string },
  remedyType: string,
  materials: string[],
  lang: string
): Array<{ category: string; search_query: string; what_to_look_for: string; notes?: string }> {
  const t = {
    en: { 
      temple: "Look for Hindu temples with active pooja services and trained priests",
      priest: "Certified purohit who can perform the specific ritual",
      store: "Religious supply store with authentic ritual items",
      puja: "Find a temple or priest who can perform this specific puja ceremony",
      mantra: "Look for a guru or temple priest to teach proper pronunciation",
      yantra: "Find a qualified astrologer or tantric practitioner for yantra preparation",
      ratna: "Visit a certified gemstone dealer - ask for authenticity certificate",
      dana: "Temple donation office or charitable religious organization",
      vrata: "Temple priest who can guide the fasting protocol",
      aushadhi: "Ayurvedic pharmacy or practitioner for medicinal herbs"
    },
    es: {
      temple: "Busque templos hindúes con servicios de pooja activos y sacerdotes capacitados",
      priest: "Purohit certificado que pueda realizar el ritual específico",
      store: "Tienda de artículos religiosos con productos auténticos",
      puja: "Encuentre un templo o sacerdote que pueda realizar esta puja específica",
      mantra: "Busque un guru o sacerdote del templo para enseñar pronunciación",
      yantra: "Encuentre astrólogo calificado para preparación de yantra",
      ratna: "Visite un joyero certificado de gemas - pida certificado de autenticidad",
      dana: "Oficina de donaciones del templo u organización religiosa benéfica",
      vrata: "Sacerdote del templo que pueda guiar el protocolo de ayuno",
      aushadhi: "Farmacia ayurvédica o practicante para hierbas medicinales"
    },
    it: {
      temple: "Cercare templi indù con servizi pooja attivi e sacerdoti qualificati",
      priest: "Purohit certificato in grado di eseguire il rituale specifico",
      store: "Negozio di articoli religiosi con oggetti rituali autentici",
      puja: "Trovare un tempio o sacerdote che possa eseguire questa puja specifica",
      mantra: "Cercare un guru o sacerdote del tempio per insegnare la pronuncia",
      yantra: "Trovare astrologo qualificato per preparazione yantra",
      ratna: "Visita gioielliere certificato di gemme - chiedi certificato autenticità",
      dana: "Ufficio donazioni del tempio o organizzazione religiosa caritatevole",
      vrata: "Sacerdote del tempio che può guidare il protocollo di digiuno",
      aushadhi: "Farmacia ayurvedica o praticante per erbe medicinali"
    }
  }[lang] || t.en;
  
  const suggestions: Array<{ category: string; search_query: string; what_to_look_for: string; notes?: string }> = [];
  
  // Always suggest temple
  suggestions.push({
    category: "temple",
    search_query: `${location.city} hindu temple pooja services`,
    what_to_look_for: t.temple,
    notes: lang === 'es' ? 'Pregunte por sacerdotes que hablen español si es necesario' : 
           lang === 'it' ? 'Chiedi se ci sono sacerdoti che parlano italiano' : 
           'Ask for English-speaking priests if needed'
  });
  
  // Type-specific suggestions
  const typeSearches: Record<string, { category: string; query: string; desc: string }> = {
    mantra: { category: "priest", query: `${location.city} vedic guru mantra teaching`, desc: t.mantra },
    yantra: { category: "priest", query: `${location.city} yantra preparation astrologer tantric`, desc: t.yantra },
    puja: { category: "temple", query: `${location.city} pooja ceremony services priest home`, desc: t.puja },
    ratna: { category: "store", query: `${location.city} certified gemstone dealer jyotish`, desc: t.ratna },
    dana: { category: "temple", query: `${location.city} temple donation charity religious`, desc: t.dana },
    vrata: { category: "priest", query: `${location.city} vrata fasting guidance priest`, desc: t.vrata },
    aushadhi: { category: "store", query: `${location.city} ayurvedic pharmacy medicinal herbs`, desc: t.aushadhi }
  };
  
  if (typeSearches[remedyType]) {
    suggestions.push({
      category: typeSearches[remedyType].category,
      search_query: typeSearches[remedyType].query,
      what_to_look_for: typeSearches[remedyType].desc
    });
  }
  
  // Material-specific suggestions
  const translations = materialTranslations[lang] || materialTranslations.en;
  
  materials.forEach((mat: string) => {
    const translation = translations[mat] || translations[mat.toLowerCase()];
    if (translation) {
      const searchQuery = `${location.city} ${translation.search_terms[0]}`;
      suggestions.push({
        category: "store",
        search_query: searchQuery,
        what_to_look_for: `${mat} (${translation.local})`,
        notes: `Search terms: ${translation.search_terms.join(', ')}`
      });
    }
  });
  
  return suggestions;
}

// Online alternatives (verified)
function getOnlineAlternatives(remedyType: string, lang: string): Array<{ name: string; what_they_offer: string; website: string }> {
  const alternatives: Record<string, Array<{ name: string; what_they_offer: string; website: string }>> = {
    mantra: [
      { name: "Arsha Vidya Gurukulam", what_they_offer: "Vedic mantra learning resources", website: "https://www.arshavidya.org" },
      { name: "Sanskrit Documents", what_they_offer: "Authentic Sanskrit mantra texts", website: "https://sanskritdocuments.org" }
    ],
    yantra: [
      { name: "Sri Yantra Study", what_they_offer: "Yantra geometry and construction guides", website: "https://srivantra.org" }
    ],
    ratna: [
      { name: "Gemological Institute", what_they_offer: "Gemstone certification information", website: "https://www.gia.edu" }
    ],
    general: [
      { name: "Vedic Astrology Resources", what_they_offer: "Vedic astrology texts and guides", website: "https://www.vedicastrology.org" },
      { name: "Ayurveda Institute", what_they_offer: "Ayurvedic resources and herbs", website: "https://www.ayurveda.com" }
    ]
  };
  
  return alternatives[remedyType] || alternatives.general;
}

//////////////////////////////////////////////////
// MAIN HANDLER
//////////////////////////////////////////////////

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { 
      status: 405, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
  
  try {
    const body = await req.json();
    const { lat, lng, remedyType = "general", materials = [], lang = "en" } = body;
    
    if (!lat || !lng) {
      return new Response(JSON.stringify({ error: "Latitude and longitude required" }), { 
        status: 400, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
    
    // Reverse geocode location
    const location = await reverseGeocode(lat, lng);
    
    // Build search suggestions
    const searchSuggestions = buildSearchSuggestions(location, remedyType, materials, lang);
    
    // Get online alternatives
    const onlineAlternatives = getOnlineAlternatives(remedyType, lang);
    
    // Generate guidance based on location
    const guidance: Record<string, string> = {
      en: `Resources near ${location.display}. These are search suggestions - click to view on Google Maps.`,
      es: `Recursos cerca de ${location.display}. Estas son sugerencias de búsqueda - haga clic para ver en Google Maps.`,
      it: `Risorse vicino a ${location.display}. Questi sono suggerimenti di ricerca - clicca per vedere su Google Maps.`
    };
    
    const disclaimer: Record<string, string> = {
      en: "We do not store locations. All search suggestions are generated locally. Please verify authenticity before purchasing religious items or services.",
      es: "No almacenamos ubicaciones. Todas las sugerencias se generan localmente. Verifique la autenticidad antes de comprar artículos o servicios religiosos.",
      it: "Non memorizziamo le posizioni. Tutti i suggerimenti sono generati localmente. Verifica l'autenticità prima di acquistare articoli o servizi religiosi."
    };
    
    return new Response(JSON.stringify({
      success: true,
      resources: {
        meta: {
          lat,
          lng,
          location_display: location.display,
          city: location.city,
          province: location.province,
          country: location.country,
          lang
        },
        guidance: guidance[lang] || guidance.en,
        search_suggestions: searchSuggestions,
        online_alternatives: onlineAlternatives,
        disclaimer: disclaimer[lang] || disclaimer.en
      }
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    
  } catch (error) {
    console.error("Local resources error:", error);
    return new Response(JSON.stringify({ 
      success: false, 
      error: error.message 
    }), { 
      status: 500, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
});
