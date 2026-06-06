export interface Label {
  id: string;
  name: string;
  notionPageId?: string;
  spotifyLabelName: string;
  contacts: LabelContact[];
  releaseCadence?: ReleaseCadence;
  relationship: 'active_client' | 'past_client' | 'prospect' | 'unknown';
  genres: string[];
}

export interface LabelContact {
  name: string;
  email: string;
  role?: string;
  lastContactDate?: string;
}

export interface Artist {
  id: string;
  name: string;
  spotifyId?: string;
  labelName: string;
  tier: 'emerging' | 'mid' | 'established' | 'major';
  monthlyListeners?: number;
  followers?: number;
  genres: string[];
  hasWorkedWithRT: boolean;
  notionPageId?: string;
}

export interface ReleaseCadence {
  averageDaysBetweenReleases: number;
  lastReleaseDate: string;
  nextExpectedWindow: string;
  confidence: number;
}

export interface Lead {
  id: string;
  artist: Artist;
  label: Label;
  score: number;
  signals: OutreachSignal[];
  status: 'new' | 'scored' | 'drafted' | 'sent' | 'replied' | 'converted' | 'passed';
  createdAt: string;
  outreachDraft?: string;
  notionPageId?: string;
}

export interface OutreachSignal {
  type: 'upcoming_release' | 'gap_in_coverage' | 'relationship_proximity' | 'genre_fit' | 'social_growth';
  description: string;
  strength: number; // 0-1
  detectedAt: string;
}

export interface LeadScore {
  total: number; // 0-100
  breakdown: {
    genreFit: number;
    tierFit: number;
    timing: number;
    relationshipProximity: number;
    recency: number;
  };
  reasoning: string;
}

export interface Opportunity {
  leadId: string;
  artist: Artist;
  label: Label;
  signals: OutreachSignal[];
  enrichment: OpportunityEnrichment;
}

export interface OpportunityEnrichment {
  gmailHistory: string[];
  spotifyMetrics: {
    monthlyListeners: number;
    followers: number;
    recentReleases: SpotifyRelease[];
  };
  crmNotes: string[];
}

export interface SpotifyRelease {
  name: string;
  releaseDate: string;
  type: 'single' | 'album' | 'ep';
  trackCount: number;
}

export interface OutreachDraft {
  subject: string;
  body: string;
  recipientEmail: string;
  recipientName: string;
  contextUsed: string[];
  leadId: string;
}

export interface WatcherState {
  lastReleaseScan: string;
  lastGapAnalysis: string;
  trackedLabels: string[];
  pendingOpportunities: number;
}
