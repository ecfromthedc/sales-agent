SET search_path TO henry, public;
\copy anchors FROM 'db/csv/anchors.csv' CSV HEADER
\copy labels FROM 'db/csv/labels.csv' CSV HEADER
\copy leads FROM 'db/csv/leads.csv' CSV HEADER
\copy peer_edges FROM 'db/csv/peer_edges.csv' CSV HEADER
\copy releases FROM 'db/csv/releases.csv' CSV HEADER
\copy raw_leads FROM 'db/csv/raw_leads.csv' CSV HEADER
\copy raw_peer_edges FROM 'db/csv/raw_peer_edges.csv' CSV HEADER
\copy contacts FROM 'db/csv/contacts.csv' CSV HEADER
