window.APP_CONFIG = {
  API_BASE_URL: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/ashtamangala",
  
  // Shared Services (cross-project)
  SHARED_SERVICES: {
    rng: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/shared-rng",
    translate: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/yijingtu-translate",
    export: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/shared-export",
    cache: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/shared-cache",
    rag: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/shared-rag"
  },
  
  ENDPOINTS: {
    // Disperse functions (entropy/beacon/distribute)
    // Note: Beacon endpoint now proxied through shared-rng for superior entropy
    disperse: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/disperse",
    disperseSwarna: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/disperse/swarna",
    distribute: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/disperse/distribute",
    
    // Interpret functions (Rishi analysis)
    interpret: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/ashtamangala/interpret",
    interpretTechnical: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/ashtamangala/interpret/technical",
    interpretNarrative: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/ashtamangala/interpret/narrative",
    interpretStructure: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/ashtamangala/interpret/structure",
    interpretAdvice: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/ashtamangala/interpret/advice",
    localResources: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/ashtamangala/local-resources",
    export: "https://vflkhntzwfovnuyccxow.supabase.co/functions/v1/ashtamangala/export"
  }
};
