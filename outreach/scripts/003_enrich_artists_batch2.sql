-- ============================================================
-- BATCH 2 Artist Enrichment: Batches 3, 4, 5
-- Generated: 2026-05-19
-- Source: Web research (Spotify, Wikipedia, label sites, etc.)
-- ============================================================

-- ===================== BATCH 3 =====================

-- Mon Rovia (Mon Rovîa)
-- Label: Nettwerk Music Group | Mgmt: Secret Road
-- Spotify: https://open.spotify.com/artist/6pvai2QB2c0defVI0UTFos
UPDATE artists SET
  spotify_id = '6pvai2QB2c0defVI0UTFos',
  followers = 85000,
  monthly_listeners = 1500000,
  genres = '{"afro-appalachian folk","indie folk","singer-songwriter"}',
  label_name_raw = 'Nettwerk Music Group',
  management_company = 'Secret Road',
  is_independent = false,
  tier = 'emerging'
WHERE name = 'Mon Rovia';

-- Amistat
-- Label: Nettwerk Music Group | Twin brothers Josef & Jan (Australia)
-- Spotify: https://open.spotify.com/artist/24gClotFFIb7genYn5C3OU
UPDATE artists SET
  spotify_id = '24gClotFFIb7genYn5C3OU',
  followers = 15000,
  monthly_listeners = 45000,
  genres = '{"indie folk","indie pop","folk pop"}',
  label_name_raw = 'Nettwerk Music Group',
  management_company = NULL,
  is_independent = false,
  tier = 'emerging'
WHERE name = 'Amistat';

-- Amble
-- Label: Warner Music Ireland / Warner Records US | Booking: Primary Talent Intl
-- Spotify: https://open.spotify.com/artist/5ZC7GPz5h9zkEfjZBUDNzI
UPDATE artists SET
  spotify_id = '5ZC7GPz5h9zkEfjZBUDNzI',
  followers = 198000,
  monthly_listeners = 1500000,
  genres = '{"contemporary folk","indie folk","irish folk"}',
  label_name_raw = 'Warner Records',
  management_company = 'Primary Talent International',
  is_independent = false,
  tier = 'emerging'
WHERE name = 'Amble';

-- GoldKimono
-- Label: Camp Kimono Records (own label) | Publishing: BMG | Agency: Emerged Agency / Live Nation Belgium
-- Spotify: https://open.spotify.com/artist/3krHIfEy37pVe0zjdisDBk
UPDATE artists SET
  spotify_id = '3krHIfEy37pVe0zjdisDBk',
  followers = 50000,
  monthly_listeners = 424600,
  genres = '{"hip hop","dutch hip hop","island pop"}',
  label_name_raw = 'Camp Kimono Records',
  management_company = 'Emerged Agency',
  is_independent = true,
  tier = 'emerging'
WHERE name = 'GoldKimono';

-- Ferester
-- Label: Unknown (likely independent) | Glasgow, UK
-- Spotify: https://open.spotify.com/artist/6zLpTEeO256aVCCbrg6RpX
UPDATE artists SET
  spotify_id = '6zLpTEeO256aVCCbrg6RpX',
  followers = 12000,
  monthly_listeners = 97100,
  genres = '{"indie pop","pop","glasgow indie"}',
  label_name_raw = NULL,
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Ferester';

-- Flavia (FLAVIA Watson / flaviaspeaks)
-- Label: Unknown (likely independent) | LA-based
-- Spotify: https://open.spotify.com/artist/4KvJPTW5GGjm49mMuzftPA
UPDATE artists SET
  spotify_id = '4KvJPTW5GGjm49mMuzftPA',
  followers = 500,
  monthly_listeners = 112,
  genres = '{"electropop","indie pop","singer-songwriter"}',
  label_name_raw = NULL,
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Flavia';

-- Gunnar (Gunnar Gehl)
-- Label: Unknown (likely independent post-Warner) | Newport Beach, CA
-- Spotify: https://open.spotify.com/artist/3o4OtMGLmvvLSx19ZjtuSn
UPDATE artists SET
  spotify_id = '3o4OtMGLmvvLSx19ZjtuSn',
  followers = 25000,
  monthly_listeners = 100000,
  genres = '{"pop","indie pop","social media pop"}',
  label_name_raw = NULL,
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Gunnar';

-- Haley Joelle
-- Label: Independent (via DistroKid) | DIY artist
-- Spotify: https://open.spotify.com/artist/4pZOG8ump4odtJJA4Cy7S8
UPDATE artists SET
  spotify_id = '4pZOG8ump4odtJJA4Cy7S8',
  followers = 111156,
  monthly_listeners = 5000000,
  genres = '{"alt z","gen z singer-songwriter","indie pop"}',
  label_name_raw = 'Independent (DistroKid)',
  management_company = NULL,
  is_independent = true,
  tier = 'mid'
WHERE name = 'Haley Joelle';

-- Spencer Ludwig
-- Label: Trumpet Records (own label, founded 2018) | Former: Warner Records
-- Spotify: https://open.spotify.com/artist/6miuYP0AovZaaKpRFaDQMQ
UPDATE artists SET
  spotify_id = '6miuYP0AovZaaKpRFaDQMQ',
  followers = 15000,
  monthly_listeners = 116100,
  genres = '{"pop","trumpet pop","electronic","latin pop"}',
  label_name_raw = 'Trumpet Records',
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Spencer Ludwig';

-- Transviolet
-- Label: Independent (formerly Epic Records / Sony BMG)
-- Spotify: https://open.spotify.com/artist/7ixzNQXQ64I2ayrtyhlF7i
UPDATE artists SET
  spotify_id = '7ixzNQXQ64I2ayrtyhlF7i',
  followers = 35000,
  monthly_listeners = 168800,
  genres = '{"alt z","electropop","indie poptimism","vapor soul"}',
  label_name_raw = 'Independent',
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Transviolet';


-- ===================== BATCH 4 =====================

-- Phillip-Michael Scales
-- Label: Dixie Frog Records | BB King's nephew | Berklee-trained
-- Spotify: https://open.spotify.com/artist/0GUFrEry7OHxPMcpjPH9lQ
UPDATE artists SET
  spotify_id = '0GUFrEry7OHxPMcpjPH9lQ',
  followers = 5000,
  monthly_listeners = 48400,
  genres = '{"dive bar soul","folk","soul","blues","indie rock"}',
  label_name_raw = 'Dixie Frog Records',
  management_company = 'Bass/Schuler Entertainment',
  is_independent = false,
  tier = 'emerging'
WHERE name = 'Phillip-Michael Scales';

-- Nate Bergman
-- Label: Velocity Records | Nashville-based
-- Spotify: https://open.spotify.com/artist/1reLQzWC7pBz93qGxZFOkP
UPDATE artists SET
  spotify_id = '1reLQzWC7pBz93qGxZFOkP',
  followers = 2000,
  monthly_listeners = 7100,
  genres = '{"americana","folk rock","country","soul","blues"}',
  label_name_raw = 'Velocity Records',
  management_company = NULL,
  is_independent = false,
  tier = 'emerging'
WHERE name = 'Nate Bergman';

-- Carter Faith
-- Label: MCA Nashville / Universal Music Group Nashville
-- Spotify: https://open.spotify.com/artist/4X5CTYQmx1NNyz9S1IpNko
UPDATE artists SET
  spotify_id = '4X5CTYQmx1NNyz9S1IpNko',
  followers = 85000,
  monthly_listeners = 756300,
  genres = '{"country","country pop","singer-songwriter"}',
  label_name_raw = 'MCA Nashville / Universal Music Group Nashville',
  management_company = NULL,
  is_independent = false,
  tier = 'mid'
WHERE name = 'Carter Faith';

-- Troy Ramey
-- Label: Independent | The Voice alumni
-- Spotify: https://open.spotify.com/artist/1Uxi0A4WHWH93Fyi0gWHEF
UPDATE artists SET
  spotify_id = '1Uxi0A4WHWH93Fyi0gWHEF',
  followers = 15000,
  monthly_listeners = 112600,
  genres = '{"soul","folk","blues","singer-songwriter"}',
  label_name_raw = 'Independent',
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Troy Ramey';

-- Family Company
-- Label: Unknown
-- Spotify: https://open.spotify.com/artist/68TMIdW3csuFrzKleLKrM0
UPDATE artists SET
  spotify_id = '68TMIdW3csuFrzKleLKrM0',
  followers = 30000,
  monthly_listeners = 266900,
  genres = '{"indie folk","indie pop","folk pop"}',
  label_name_raw = NULL,
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Family Company';

-- Alex Aiono
-- Label: Become Records (own, independent) | Formerly: Interscope Records
-- Spotify: https://open.spotify.com/artist/5KPJMJR9PCfMWSfco8i4W4
UPDATE artists SET
  spotify_id = '5KPJMJR9PCfMWSfco8i4W4',
  followers = 120000,
  monthly_listeners = 59400,
  genres = '{"pop","r&b","gospel pop"}',
  label_name_raw = 'Become Records',
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Alex Aiono';

-- Big Boss Vette
-- Label: Republic Records / Amigo Records / Beatstaz
-- Spotify: https://open.spotify.com/artist/6fKiutMtRIcxi4zEau0BuI
UPDATE artists SET
  spotify_id = '6fKiutMtRIcxi4zEau0BuI',
  followers = 91142,
  monthly_listeners = 2300000,
  genres = '{"trap queen","hip hop","rap"}',
  label_name_raw = 'Republic Records',
  management_company = NULL,
  is_independent = false,
  tier = 'established'
WHERE name = 'Big Boss Vette';

-- Wyclef Jean
-- Label: Columbia Records (historically) | Fugees member
-- Spotify: https://open.spotify.com/artist/7aBzpmFXB4WWpPl2F7RjBe
UPDATE artists SET
  spotify_id = '7aBzpmFXB4WWpPl2F7RjBe',
  followers = 1800000,
  monthly_listeners = 6400000,
  genres = '{"hip hop","reggae","alternative rap","pop","r&b"}',
  label_name_raw = 'Columbia Records',
  management_company = NULL,
  is_independent = false,
  tier = 'major'
WHERE name = 'Wyclef Jean';

-- French Montana
-- Label: Bad Boy / Epic Records
-- Spotify: https://open.spotify.com/artist/6vXTefBL93Dj5IqAWq6OTv
UPDATE artists SET
  spotify_id = '6vXTefBL93Dj5IqAWq6OTv',
  followers = 5545028,
  monthly_listeners = 27000000,
  genres = '{"hip hop","pop","rap","southern hip hop","trap"}',
  label_name_raw = 'Bad Boy / Epic Records',
  management_company = NULL,
  is_independent = false,
  tier = 'major'
WHERE name = 'French Montana';

-- Rick Ross
-- Label: Maybach Music Group / Epic Records
-- Spotify: https://open.spotify.com/artist/1sBkRIssrMs1AbVkOJbc7a
UPDATE artists SET
  spotify_id = '1sBkRIssrMs1AbVkOJbc7a',
  followers = 7938197,
  monthly_listeners = 15600000,
  genres = '{"dirty south rap","gangster rap","hip hop","rap","southern hip hop","trap"}',
  label_name_raw = 'Maybach Music Group / Epic Records',
  management_company = NULL,
  is_independent = false,
  tier = 'major'
WHERE name = 'Rick Ross';


-- ===================== BATCH 5 =====================

-- Jake Marsh
-- Label: Independent | Self-produced | NYU Clive Davis
-- Spotify: https://open.spotify.com/artist/5K6IfB5Ntc1cPrLY1WE9Ao
UPDATE artists SET
  spotify_id = '5K6IfB5Ntc1cPrLY1WE9Ao',
  followers = 5000,
  monthly_listeners = 50100,
  genres = '{"indie pop","alt rock","singer-songwriter"}',
  label_name_raw = 'Independent',
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Jake Marsh';

-- Highup
-- Label: Unknown | Limited data available
-- Spotify: (ID not confirmed)
UPDATE artists SET
  spotify_id = NULL,
  followers = NULL,
  monthly_listeners = NULL,
  genres = '{"indie","alternative"}',
  label_name_raw = NULL,
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Highup';

-- Chris Burke
-- Label: Independent | Nashville, TN
-- Spotify: https://open.spotify.com/artist/7DuMrjdqPSIiF85TF8hoiV
UPDATE artists SET
  spotify_id = '7DuMrjdqPSIiF85TF8hoiV',
  followers = 3000,
  monthly_listeners = 20400,
  genres = '{"soul","singer-songwriter","indie pop"}',
  label_name_raw = 'Independent',
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Chris Burke';

-- Manning Rothrock
-- Label: Unknown (likely independent)
-- Spotify: https://open.spotify.com/artist/7bG7ShZr4ntbtrnwVCN3RP
UPDATE artists SET
  spotify_id = '7bG7ShZr4ntbtrnwVCN3RP',
  followers = 25000,
  monthly_listeners = 241200,
  genres = '{"indie folk","singer-songwriter","indie pop"}',
  label_name_raw = NULL,
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Manning Rothrock';

-- Just Seconds Apart
-- Label: Unknown (likely independent)
-- Spotify: https://open.spotify.com/artist/4G97Uz6XLaPObFB0dUPqy6
UPDATE artists SET
  spotify_id = '4G97Uz6XLaPObFB0dUPqy6',
  followers = 500,
  monthly_listeners = 3400,
  genres = '{"indie","alternative","indie rock"}',
  label_name_raw = NULL,
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Just Seconds Apart';

-- Brady Toops
-- Label: Independent | Former minor league baseball player (Cardinals)
-- Spotify: https://open.spotify.com/artist/5av8KJJVSCVzfVNcubhk8l
UPDATE artists SET
  spotify_id = '5av8KJJVSCVzfVNcubhk8l',
  followers = 3000,
  monthly_listeners = 18100,
  genres = '{"indie pop","worship","roots worship","singer-songwriter"}',
  label_name_raw = 'Independent',
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Brady Toops';

-- Frayne Vibez
-- Label: Unknown (independent)
-- Spotify: https://open.spotify.com/artist/3QeZX6HWNcYAyHKxYP0ws5
UPDATE artists SET
  spotify_id = '3QeZX6HWNcYAyHKxYP0ws5',
  followers = 50,
  monthly_listeners = 123,
  genres = '{"indie","alternative"}',
  label_name_raw = NULL,
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Frayne Vibez';

-- Limage
-- Label: Unknown
-- Spotify: https://open.spotify.com/artist/7uezObA5zpd0BUDsxnQ0Y6
UPDATE artists SET
  spotify_id = '7uezObA5zpd0BUDsxnQ0Y6',
  followers = 5000,
  monthly_listeners = 46700,
  genres = '{"r&b","soul","indie"}',
  label_name_raw = NULL,
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Limage';

-- Josiah and the Bonnevilles
-- Label: Yucatan Records | Morristown, TN / Nashville
-- Spotify: https://open.spotify.com/artist/3FMcVBx2TMq2f5gEPcUieC
UPDATE artists SET
  spotify_id = '3FMcVBx2TMq2f5gEPcUieC',
  followers = 150000,
  monthly_listeners = 1500000,
  genres = '{"indie rock","folk rock","americana","classic rock fusion"}',
  label_name_raw = 'Yucatan Records',
  management_company = NULL,
  is_independent = false,
  tier = 'emerging'
WHERE name = 'Josiah and the Bonnevilles';

-- Liam St John
-- Label: Independent (likely) | LA-based blues-rock
-- Spotify: https://open.spotify.com/artist/7sbLMJ3A72T1ZnNUNrxcqx
UPDATE artists SET
  spotify_id = '7sbLMJ3A72T1ZnNUNrxcqx',
  followers = 40000,
  monthly_listeners = 411100,
  genres = '{"blues","blues rock","soul","rock"}',
  label_name_raw = 'Independent',
  management_company = NULL,
  is_independent = true,
  tier = 'emerging'
WHERE name = 'Liam St John';
