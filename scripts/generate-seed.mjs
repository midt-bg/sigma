import fs from 'fs';

const authorities = [];
const tenders = [];
const lots = [];
const bidders = [];
const contracts = [];
const amendments = [];
const parties = [];

const cpvCodes = ['15000000', '45000000', '72000000', '33000000', '09000000'];
const procedures = ['открита процедура', 'пряко договаряне', 'публично състезание'];
const regions = ['София-град', 'Пловдив', 'Варна', 'Бургас', 'Русе', 'Стара Загора'];
const nutsCodes = ['BG411', 'BG421', 'BG331', 'BG341', 'BG323', 'BG344'];

for (let i = 1; i <= 100; i++) {
  const eikAuthority = String(100000000 + i);
  const eikBidder = String(104690000 + i);
  const regionIndex = i % regions.length;
  const nuts = nutsCodes[regionIndex];
  const city = regions[regionIndex];

  // Authority
  const authId = `auth:${eikAuthority}`;
  authorities.push(`('${authId}', 'Община Мок-${i}', '${eikAuthority}', '${city}')`);
  parties.push(
    `('party-auth-${i}', '${eikAuthority}', 'mock', null, null, 'Община Мок-${i}', 'Ул. Тест ${i}', '${city}', '${nuts}', 'contact@mock${i}.bg', '0888000${i.toString().padStart(3, '0')}')`,
  );

  // Bidder
  const bidderId = `eik:${eikBidder}`;
  bidders.push(`('${bidderId}', 'Фирма Мок ${i} ЕООД', '${eikBidder}', '${eikBidder}', 1)`);
  parties.push(
    `('party-bidder-${i}', '${eikBidder}', 'mock', null, null, 'Фирма Мок ${i} ЕООД', 'Бул. Бизнес ${i}', '${city}', '${nuts}', 'office@mock-company${i}.bg', '0899000${i.toString().padStart(3, '0')}')`,
  );

  // Tender
  const tenderId = `tender-mock-${i}`;
  const unp = `AOP-MOCK-${i}`;
  const val = 10000 + Math.floor(Math.random() * 5000000);
  tenders.push(
    `('${tenderId}', '${unp}', 'Обществена поръчка ${i}', '${authId}', '${cpvCodes[i % cpvCodes.length]}', ${val}, 'BGN', '${procedures[i % procedures.length]}', 'published', '2026-01-01', '2026-02-01')`,
  );

  // Lot (1 for every 3 tenders)
  let lotIdStr = 'NULL';
  if (i % 3 === 0) {
    const lotId = `lot-${unp}-1`;
    lots.push(
      `('${lotId}', '${tenderId}', 'Обособена позиция 1', '${cpvCodes[i % cpvCodes.length]}', ${val}, ${val}, 'BGN')`,
    );
    lotIdStr = `'${lotId}'`;
  }

  // Contract
  const contractId = `contract-mock-${i}`;
  const contractNum = `Д-МОК-${i}/2026`;
  const signingVal = val * 0.9;
  let currentVal = signingVal;

  // Amendment (1 for every 5 contracts)
  let annexCount = 0;
  if (i % 5 === 0) {
    annexCount = 1;
    currentVal = signingVal * 1.1; // 10% increase
    const delta = currentVal - signingVal;
    amendments.push(
      `('amend-${i}', 'natural-${i}', '${contractNum}', '${unp}', ${signingVal}, ${currentVal}, ${delta}, 'BGN', '2026-04-01', 'mock-source')`,
    );
  }

  const currentValEur = currentVal / 1.95583;
  const signingValEur = signingVal / 1.95583;
  contracts.push(
    `('${contractId}', '${tenderId}', '${bidderId}', ${signingVal}, 'BGN', '2026-03-01', '${contractNum}', ${signingVal}, ${currentVal}, ${annexCount}, ${i % 2}, ${currentValEur}, ${signingValEur}, ${currentValEur}, ${lotIdStr}, 'Договор за поръчка ${i}')`,
  );
}

let sql = `
-- Sample data for local development. Idempotent (INSERT OR IGNORE).
-- Auto-generated mock data (100 rows + lots + amendments + parties)

INSERT OR IGNORE INTO authorities (id, name, bulstat, region) VALUES
${authorities.join(',\n')};

INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency, procedure_type, status, published_at, deadline_at)
VALUES
${tenders.join(',\n')};

INSERT OR IGNORE INTO lots
  (id, tender_id, title, cpv_code, estimated_value, value_amount, value_currency)
VALUES
${lots.join(',\n')};

INSERT OR IGNORE INTO bidders (id, name, bulstat, eik_normalized, eik_valid) VALUES
${bidders.join(',\n')};

INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at, contract_number, signing_value, current_value, annex_count, eu_funded, amount_eur, signing_value_eur, current_value_eur, lot_id, contract_subject)
VALUES
${contracts.join(',\n')};

INSERT OR IGNORE INTO amendments
  (id, natural_key, contract_number, unp, value_before, value_after, value_delta, currency, published_at, source)
VALUES
${amendments.join(',\n')};

INSERT OR IGNORE INTO parties
  (party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts, contact_email, contact_phone)
VALUES
${parties.join(',\n')};
`;

fs.writeFileSync('scripts/seed.sql', sql);
console.log('Successfully generated scripts/seed.sql with extended mock entities.');
