export const privacy = {
  metaTitle: 'Privacy Policy — СИГМА',
  metaDescription: 'How СИГМА processes public data and what rights data subjects have.',
  crumb: 'Privacy',
  kicker: 'Legal information',
  title: 'Privacy Policy',
  lede: 'This page describes how СИГМА uses public procurement data and how you can exercise your rights.',
  sections: {
    controller: {
      heading: 'Controller',
      controllerLabel: 'Controller',
      controllerValue: 'Ministry of Innovation and Digital Transformation (MIDT)',
      addressLabel: 'Address',
      addressValue: '12 Knyaz Aleksandar I St, Sofia 1000',
      contactLabel: 'Contact',
    },
    data: {
      heading: 'Data and sources',
      body1:
        'СИГМА displays publicly available data on public procurement: contracting authorities, contractors, contracts, values, dates, CPV codes, procurement reference numbers (UNP), and related identifiers.',
      body2:
        'The sources are the Public Procurement Agency (AOP) and the CAIS EOP platform, via the open data from storage.eop.bg. Where the data contains personal data, notification is carried out under Article 14 of the General Data Protection Regulation (GDPR), because the data was not obtained directly from the data subjects.',
    },
    basis: {
      heading: 'Legal basis',
      body1:
        'Processing is carried out to perform a task in the public interest under Article 6(1)(e) GDPR: public transparency and citizen access to data on the spending of public funds.',
      body2:
        'Where applicable, processing is also based on the legitimate interest under Article 6(1)(f) GDPR of maintaining a publicly accessible analytical service over already published data.',
    },
    rights: {
      heading: 'Rights of data subjects',
      body1:
        'You may request information, access, rectification, restriction of processing, and review of a specific record. You have the right to object under Article 21 GDPR and the right to erasure under Article 17 GDPR where the legal grounds apply.',
      body2Prefix: 'Requests are sent to',
      body2Suffix:
        '. Specify the particular record, URL, or identifier (for example a company ID (EIK), procurement reference number (UNP), or contract number) so that the request can be handled accurately.',
    },
    logs: {
      heading: 'Technical logs',
      body1:
        'For security, abuse prevention, and the normal operation of the service, СИГМА keeps brief technical logs of requests. Each entry includes the date and time, the requested path (without the content of the search query), the HTTP status, the processing duration, and a pseudonymous client identifier.',
      body2:
        'The IP address is not stored in clear form. The client identifier is derived from the IP address through an irreversible function with a secret key (HMAC-SHA-256), which allows repeat requests from a single client to be recognised for security purposes without the address being recoverable from the record.',
      body3:
        'The content of searches is not recorded — we note only that a search was performed and the length of the entered text, but not the text itself. We do not build user profiles.',
      body4:
        'Request processing at the infrastructure level is carried out by Cloudflare acting as a data processor. Logs are stored for a short period according to the platform settings and are then deleted automatically. The legal basis is the legitimate interest under Article 6(1)(f) GDPR in the security and maintenance of the publicly accessible service.',
    },
    retention: {
      heading: 'Retention and limitations',
      body1:
        'СИГМА does not require registration and does not store user profiles. Public procurement data is displayed for as long as it is needed for transparency, analysis, and the traceability of public spending, or until a legal basis requires a change.',
      operatorPrefix: 'For information about the operator, see ',
      operatorLink: 'Imprint',
      operatorSuffix: '.',
    },
  },
};
