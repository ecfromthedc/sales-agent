-- 002_enrich_artists.sql
-- Artist ecosystem enrichment data
-- Generated: 2026-05-19
-- Sources: Spotify, Billboard, Wikipedia, Music industry databases
-- Note: Follower/listener counts are approximate and current as of May 2026

BEGIN;

-- =============================================================================
-- BATCH 1: Major artists
-- =============================================================================

-- Gregory Alan Isakov
-- Spotify ID: 5sXaGoRLSpd7VeyZrLkKwt
-- Genres: indie folk, folk, singer-songwriter, chamber folk
-- Label: Suitcase Town Music / Dualtone (independent-leaning)
-- Management: Unknown
UPDATE artists SET
  spotify_id = '5sXaGoRLSpd7VeyZrLkKwt',
  followers = 1200000,
  monthly_listeners = 8600000,
  genres = '{"indie folk","folk","singer-songwriter","chamber folk"}',
  label_name_raw = 'Suitcase Town Music / Dualtone',
  management_company = NULL,
  is_independent = true,
  tier = 'established'
WHERE name = 'Gregory Alan Isakov';

-- Dasha
-- Spotify ID: 7Ez6lTtSMjMf2YSYpukP1I
-- Genres: country, modern country pop, gen z singer-songwriter, pop
-- Label: Warner Records (signed March 2024)
-- Management: Type A Management (Alex Lunt)
-- Booking: WME
UPDATE artists SET
  spotify_id = '7Ez6lTtSMjMf2YSYpukP1I',
  followers = 1500000,
  monthly_listeners = 13000000,
  genres = '{"country","modern country pop","gen z singer-songwriter","pop"}',
  label_name_raw = 'Warner Records',
  management_company = 'Type A Management',
  is_independent = false,
  tier = 'established'
WHERE name = 'Dasha';

-- Myles Smith
-- Spotify ID: 3bO19AOone0ubCsfDXDtYt
-- Genres: folk pop, indie pop, UK pop
-- Label: RCA UK / Sony Music
-- Management: Unknown
UPDATE artists SET
  spotify_id = '3bO19AOone0ubCsfDXDtYt',
  followers = 4000000,
  monthly_listeners = 20300000,
  genres = '{"folk pop","indie pop","UK pop","singer-songwriter"}',
  label_name_raw = 'RCA UK / Sony Music',
  management_company = NULL,
  is_independent = false,
  tier = 'established'
WHERE name = 'Myles Smith';

-- Tucker Wetmore
-- Spotify ID: 4sCKpwwEsgReZxjtKFm2A0
-- Genres: country, modern country, country rock
-- Label: UMG Nashville / Back Blocks Music
-- Management: Unknown
-- Booking: CMA Talent Agency
UPDATE artists SET
  spotify_id = '4sCKpwwEsgReZxjtKFm2A0',
  followers = 800000,
  monthly_listeners = 3200000,
  genres = '{"country","modern country","country rock"}',
  label_name_raw = 'UMG Nashville / Back Blocks Music',
  management_company = NULL,
  is_independent = false,
  tier = 'mid'
WHERE name = 'Tucker Wetmore';

-- Daniel Seavey
-- Spotify ID: 21z8to3YxZXgKYJpBB54P2
-- Genres: pop, alternative pop, indie pop
-- Label: Atlantic Records
-- Management: Unknown
UPDATE artists SET
  spotify_id = '21z8to3YxZXgKYJpBB54P2',
  followers = 200000,
  monthly_listeners = 1800000,
  genres = '{"pop","alternative pop","indie pop"}',
  label_name_raw = 'Atlantic Records',
  management_company = NULL,
  is_independent = false,
  tier = 'mid'
WHERE name = 'Daniel Seavey';

-- Caleb Hearn
-- Spotify ID: 0EiNdCUwM4B5GkTInLAyuj
-- Genres: indie pop, pop, singer-songwriter
-- Label: Nettwerk Music Group
-- Management: Unknown
UPDATE artists SET
  spotify_id = '0EiNdCUwM4B5GkTInLAyuj',
  followers = 500000,
  monthly_listeners = 4000000,
  genres = '{"indie pop","pop","singer-songwriter"}',
  label_name_raw = 'Nettwerk Music Group',
  management_company = NULL,
  is_independent = false,
  tier = 'mid'
WHERE name = 'Caleb Hearn';

-- Wild Rivers
-- Spotify ID: 59sBwR0jPSTrbMtuTkRPN5
-- Genres: indie folk, folk pop, Canadian folk
-- Label: Nettwerk Music Group
-- Management: Loft Entertainment (Brandon Epstein & Mackenzie Fey)
-- Booking: CAA / Paquin Artists Agency
UPDATE artists SET
  spotify_id = '59sBwR0jPSTrbMtuTkRPN5',
  followers = 400000,
  monthly_listeners = 4000000,
  genres = '{"indie folk","folk pop","Canadian folk"}',
  label_name_raw = 'Nettwerk Music Group',
  management_company = 'Loft Entertainment',
  is_independent = false,
  tier = 'mid'
WHERE name = 'Wild Rivers';

-- Sam Barber
-- Spotify ID: (from Spotify URL pattern)
-- Genres: country, country rock, Americana
-- Label: Lockeland Springs / Atlantic Records
-- Management: Unknown
-- Booking: Wasserman Music
UPDATE artists SET
  spotify_id = '3FMFbMbMR7KxkYGbmSJDC8',
  followers = 1000000,
  monthly_listeners = 10000000,
  genres = '{"country","country rock","Americana"}',
  label_name_raw = 'Lockeland Springs / Atlantic Records',
  management_company = NULL,
  is_independent = false,
  tier = 'established'
WHERE name = 'Sam Barber';

-- Gavin Adcock
-- Spotify ID: 5jG6uRqinuI83luutMpW6y
-- Genres: country, modern country pop, red dirt
-- Label: Thrivin Here Records / Warner Music Nashville
-- Management: Unknown
UPDATE artists SET
  spotify_id = '5jG6uRqinuI83luutMpW6y',
  followers = 425000,
  monthly_listeners = 5700000,
  genres = '{"country","modern country pop","red dirt"}',
  label_name_raw = 'Thrivin Here Records / Warner Music Nashville',
  management_company = NULL,
  is_independent = false,
  tier = 'mid'
WHERE name = 'Gavin Adcock';

-- Twenty One Pilots
-- Spotify ID: 3YQKmKGau1PzlVlkL1iodx
-- Genres: alternative, pop, rock, electropop
-- Label: Fueled by Ramen / Elektra (Warner)
-- Management: Unknown
UPDATE artists SET
  spotify_id = '3YQKmKGau1PzlVlkL1iodx',
  followers = 26200000,
  monthly_listeners = 41500000,
  genres = '{"alternative","pop","rock","electropop"}',
  label_name_raw = 'Fueled by Ramen / Elektra',
  management_company = NULL,
  is_independent = false,
  tier = 'major'
WHERE name = 'Twenty One Pilots';

-- =============================================================================
-- BATCH 2: Mid-tier artists
-- =============================================================================

-- Emei
-- Spotify ID: 7E2aQQjErJocovYFjYLzWU
-- Genres: alt pop, indie pop, pop
-- Label: Amuse (independent distribution)
-- Management: Unknown
UPDATE artists SET
  spotify_id = '7E2aQQjErJocovYFjYLzWU',
  followers = 517000,
  monthly_listeners = 1400000,
  genres = '{"alt pop","indie pop","pop"}',
  label_name_raw = 'Amuse',
  management_company = NULL,
  is_independent = true,
  tier = 'mid'
WHERE name = 'Emei';

-- Stella Lefty
-- Spotify ID: 6hp2uD84OrQ3u3ukmTjLz2
-- Genres: indie folk, country, pop
-- Label: Livelihood Music Company (management/label)
-- Management: Livelihood Music Company
UPDATE artists SET
  spotify_id = '6hp2uD84OrQ3u3ukmTjLz2',
  followers = 150000,
  monthly_listeners = 3000000,
  genres = '{"indie folk","country","pop"}',
  label_name_raw = 'Livelihood Music Company',
  management_company = 'Livelihood Music Company',
  is_independent = true,
  tier = 'mid'
WHERE name = 'Stella Lefty';

-- Bella Kay
-- Spotify ID: 4Z8MrrKMBHMPa8d04Ivur8
-- Genres: indie pop, pop, gen z pop
-- Label: Atlantic Records
-- Management: Immersive Management (Adam Mersel & Priscilla Felten)
UPDATE artists SET
  spotify_id = '4Z8MrrKMBHMPa8d04Ivur8',
  followers = 300000,
  monthly_listeners = 5000000,
  genres = '{"indie pop","pop","gen z pop"}',
  label_name_raw = 'Atlantic Records',
  management_company = 'Immersive Management',
  is_independent = false,
  tier = 'mid'
WHERE name = 'Bella Kay';

-- Rachel Platten
-- Spotify ID: 3QLIkT4rD2FMusaqmkepbq
-- Genres: pop, singer-songwriter, pop rock
-- Label: Violet Records (own label, formerly Columbia)
-- Management: Unknown
UPDATE artists SET
  spotify_id = '3QLIkT4rD2FMusaqmkepbq',
  followers = 1500000,
  monthly_listeners = 4900000,
  genres = '{"pop","singer-songwriter","pop rock"}',
  label_name_raw = 'Violet Records',
  management_company = NULL,
  is_independent = true,
  tier = 'established'
WHERE name = 'Rachel Platten';

-- Labrinth
-- Spotify ID: 2feDdbD5araYcm6JhFHHw7
-- Genres: pop, electronic, R&B, soundtrack
-- Label: Columbia Records / Sony Music
-- Management: Unknown
UPDATE artists SET
  spotify_id = '2feDdbD5araYcm6JhFHHw7',
  followers = 3500000,
  monthly_listeners = 21600000,
  genres = '{"pop","electronic","R&B","soundtrack"}',
  label_name_raw = 'Columbia Records / Sony Music',
  management_company = NULL,
  is_independent = false,
  tier = 'established'
WHERE name = 'Labrinth';

-- Alan Walker
-- Spotify ID: 7vk5e3vY1uw9plTHJAMwjN
-- Genres: EDM, electro house, progressive house
-- Label: MER Musikk / Sony Music Sweden
-- Management: Kreatell (Gunnar Greve)
UPDATE artists SET
  spotify_id = '7vk5e3vY1uw9plTHJAMwjN',
  followers = 30000000,
  monthly_listeners = 35000000,
  genres = '{"EDM","electro house","progressive house"}',
  label_name_raw = 'MER Musikk / Sony Music Sweden',
  management_company = 'Kreatell',
  is_independent = false,
  tier = 'major'
WHERE name = 'Alan Walker';

-- Quadeca
-- Spotify ID: 3zz52ViyCBcplK0ftEVPSS
-- Genres: hip hop, experimental hip hop, alt rap
-- Label: AWAL Recordings America
-- Management: Jesse Taconelli / deadAir Records
-- Booking: Wasserman Music
UPDATE artists SET
  spotify_id = '3zz52ViyCBcplK0ftEVPSS',
  followers = 343000,
  monthly_listeners = 553000,
  genres = '{"hip hop","experimental hip hop","alt rap"}',
  label_name_raw = 'AWAL Recordings America',
  management_company = 'deadAir Records',
  is_independent = false,
  tier = 'mid'
WHERE name = 'Quadeca';

-- Lil Tjay
-- Spotify ID: 6jGMq4yGs7aQzuGsMgVgZR
-- Genres: hip hop, melodic rap, trap, pop rap
-- Label: Trench Kid Records (independent, formerly Columbia)
-- Management: Unknown
UPDATE artists SET
  spotify_id = '6jGMq4yGs7aQzuGsMgVgZR',
  followers = 10650000,
  monthly_listeners = 11700000,
  genres = '{"hip hop","melodic rap","trap","pop rap"}',
  label_name_raw = 'Trench Kid Records',
  management_company = NULL,
  is_independent = true,
  tier = 'major'
WHERE name = 'Lil Tjay';

-- Neil Young
-- Spotify ID: 6v8FB84lnmJs434UJf2Mrm
-- Genres: rock, folk rock, classic rock, singer-songwriter
-- Label: Reprise Records / Warner Music
-- Management: Lookout Management (Elliot Roberts estate)
UPDATE artists SET
  spotify_id = '6v8FB84lnmJs434UJf2Mrm',
  followers = 3000000,
  monthly_listeners = 10000000,
  genres = '{"rock","folk rock","classic rock","singer-songwriter"}',
  label_name_raw = 'Reprise Records / Warner Music',
  management_company = NULL,
  is_independent = false,
  tier = 'established'
WHERE name = 'Neil Young';

-- Diplo
-- Spotify ID: 5fMUXHkw8R8eOP2RNVYEZX
-- Genres: EDM, dance pop, electronic, moombahton
-- Label: Mad Decent (own label) / Higher Ground
-- Management: Unknown
UPDATE artists SET
  spotify_id = '5fMUXHkw8R8eOP2RNVYEZX',
  followers = 5000000,
  monthly_listeners = 15000000,
  genres = '{"EDM","dance pop","electronic","moombahton"}',
  label_name_raw = 'Mad Decent / Higher Ground',
  management_company = NULL,
  is_independent = true,
  tier = 'established'
WHERE name = 'Diplo';

-- =============================================================================
-- BATCH 3: Additional artists
-- =============================================================================

-- Sara Landry
-- Spotify ID: 7eILArMiTFTQf8SEh5fFHK
-- Genres: techno, industrial techno, hard techno
-- Label: Hekate Records (own label)
-- Management: Unknown
UPDATE artists SET
  spotify_id = '7eILArMiTFTQf8SEh5fFHK',
  followers = 200000,
  monthly_listeners = 1600000,
  genres = '{"techno","industrial techno","hard techno"}',
  label_name_raw = 'Hekate Records',
  management_company = NULL,
  is_independent = true,
  tier = 'mid'
WHERE name = 'Sara Landry';

-- Electric Guest
-- Spotify ID: 7sgWBYtJpblXpJl2lU5WVs
-- Genres: indie pop, electropop, synth pop
-- Label: Atlantic Records (formerly Downtown/Interscope)
-- Management: Monotone Inc
UPDATE artists SET
  spotify_id = '7sgWBYtJpblXpJl2lU5WVs',
  followers = 400000,
  monthly_listeners = 1500000,
  genres = '{"indie pop","electropop","synth pop"}',
  label_name_raw = 'Atlantic Records',
  management_company = 'Monotone Inc',
  is_independent = false,
  tier = 'mid'
WHERE name = 'Electric Guest';

-- Cameron Whitcomb (listed as Cam Whitcomb)
-- Spotify ID: 6dhXvR5MsnlwYguRuqoapR
-- Genres: country, folk pop, Americana
-- Label: Atlantic Records
-- Management: The Core Entertainment
UPDATE artists SET
  spotify_id = '6dhXvR5MsnlwYguRuqoapR',
  followers = 498000,
  monthly_listeners = 4500000,
  genres = '{"country","folk pop","Americana"}',
  label_name_raw = 'Atlantic Records',
  management_company = 'The Core Entertainment',
  is_independent = false,
  tier = 'mid'
WHERE name = 'Cam Whitcomb';

-- Also try the full name
UPDATE artists SET
  spotify_id = '6dhXvR5MsnlwYguRuqoapR',
  followers = 498000,
  monthly_listeners = 4500000,
  genres = '{"country","folk pop","Americana"}',
  label_name_raw = 'Atlantic Records',
  management_company = 'The Core Entertainment',
  is_independent = false,
  tier = 'mid'
WHERE name = 'Cameron Whitcomb';

-- Honey BxBy
-- Spotify ID: 4a0B39qi5Ks6KCPz0KptTO
-- Genres: R&B, hip hop, pop
-- Label: Rebirth / ART@WAR / Atlantic Records
-- Management: Unknown
UPDATE artists SET
  spotify_id = '4a0B39qi5Ks6KCPz0KptTO',
  followers = 100000,
  monthly_listeners = 260000,
  genres = '{"R&B","hip hop","pop"}',
  label_name_raw = 'Rebirth / ART@WAR / Atlantic Records',
  management_company = NULL,
  is_independent = false,
  tier = 'emerging'
WHERE name = 'Honey BxBy';

-- Jake Wesley Rogers
-- Spotify ID: 5lEF4Tt1uK7Kuk80ILMlE9
-- Genres: pop, indie pop, singer-songwriter
-- Label: Facet / Warner Records
-- Management: Unknown
UPDATE artists SET
  spotify_id = '5lEF4Tt1uK7Kuk80ILMlE9',
  followers = 50000,
  monthly_listeners = 107000,
  genres = '{"pop","indie pop","singer-songwriter"}',
  label_name_raw = 'Facet / Warner Records',
  management_company = NULL,
  is_independent = false,
  tier = 'emerging'
WHERE name = 'Jake Wesley Rogers';

-- Pecos & The Rooftops
-- Spotify ID: 5KbiLoVLLIHM5vZ0RM9WMU
-- Genres: country, red dirt, Texas country, rock
-- Label: Warner Records
-- Management: Floating Leaf Entertainment (Chase Cooper & Jeb Hurt)
UPDATE artists SET
  spotify_id = '5KbiLoVLLIHM5vZ0RM9WMU',
  followers = 300000,
  monthly_listeners = 1700000,
  genres = '{"country","red dirt","Texas country","rock"}',
  label_name_raw = 'Warner Records',
  management_company = 'Floating Leaf Entertainment',
  is_independent = false,
  tier = 'mid'
WHERE name = 'Pecos & The Rooftops';

-- Also try alternate name
UPDATE artists SET
  spotify_id = '5KbiLoVLLIHM5vZ0RM9WMU',
  followers = 300000,
  monthly_listeners = 1700000,
  genres = '{"country","red dirt","Texas country","rock"}',
  label_name_raw = 'Warner Records',
  management_company = 'Floating Leaf Entertainment',
  is_independent = false,
  tier = 'mid'
WHERE name = 'Pecos and the Rooftops';

-- Ravyn Lenae
-- Spotify ID: 5RTLRtXjbXI2lSXc6jxlAz
-- Genres: R&B, alternative R&B, indie R&B
-- Label: Atlantic Records
-- Management: Unknown
UPDATE artists SET
  spotify_id = '5RTLRtXjbXI2lSXc6jxlAz',
  followers = 500000,
  monthly_listeners = 32400000,
  genres = '{"R&B","alternative R&B","indie R&B"}',
  label_name_raw = 'Atlantic Records',
  management_company = NULL,
  is_independent = false,
  tier = 'major'
WHERE name = 'Rayvn Lenae';

-- Also try correct spelling
UPDATE artists SET
  spotify_id = '5RTLRtXjbXI2lSXc6jxlAz',
  followers = 500000,
  monthly_listeners = 32400000,
  genres = '{"R&B","alternative R&B","indie R&B"}',
  label_name_raw = 'Atlantic Records',
  management_company = NULL,
  is_independent = false,
  tier = 'major'
WHERE name = 'Ravyn Lenae';

-- Shaya Zamora
-- Spotify ID: 4gmgH3IgZoetXRskbdI02q
-- Genres: indie rock, country, Christian pop
-- Label: Atlantic Records
-- Management: Unknown
UPDATE artists SET
  spotify_id = '4gmgH3IgZoetXRskbdI02q',
  followers = 150000,
  monthly_listeners = 2000000,
  genres = '{"indie rock","country","Christian pop"}',
  label_name_raw = 'Atlantic Records',
  management_company = NULL,
  is_independent = false,
  tier = 'mid'
WHERE name = 'Shaya Zamora';

-- Haffway
-- Spotify ID: 3GL9CphwkHjP0Niz2fTWJH
-- Genres: indie folk, folk pop, singer-songwriter
-- Label: Free Flight Records / Sony Music Nashville
-- Management: Unknown
UPDATE artists SET
  spotify_id = '3GL9CphwkHjP0Niz2fTWJH',
  followers = 50000,
  monthly_listeners = 322000,
  genres = '{"indie folk","folk pop","singer-songwriter"}',
  label_name_raw = 'Free Flight Records / Sony Music Nashville',
  management_company = NULL,
  is_independent = false,
  tier = 'mid'
WHERE name = 'Haffway';

-- Also try uppercase
UPDATE artists SET
  spotify_id = '3GL9CphwkHjP0Niz2fTWJH',
  followers = 50000,
  monthly_listeners = 322000,
  genres = '{"indie folk","folk pop","singer-songwriter"}',
  label_name_raw = 'Free Flight Records / Sony Music Nashville',
  management_company = NULL,
  is_independent = false,
  tier = 'mid'
WHERE name = 'HAFFWAY';

-- Bailey Spinn
-- Spotify ID: 22qEk3r4Gv0yKjscRNjHSB
-- Genres: pop rock, pop punk, alt rock
-- Label: Unknown (likely independent)
-- Management: Unknown
UPDATE artists SET
  spotify_id = '22qEk3r4Gv0yKjscRNjHSB',
  followers = 100000,
  monthly_listeners = 500000,
  genres = '{"pop rock","pop punk","alt rock"}',
  label_name_raw = NULL,
  management_company = NULL,
  is_independent = true,
  tier = 'mid'
WHERE name = 'Bailey Spinn';

COMMIT;
