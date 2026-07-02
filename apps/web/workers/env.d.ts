interface Env {
  LOG_IP_KEY?: string;
  ASSISTANT_HMAC_KEY?: string;
  /** R2 bucket for persisted AI reports — bound by Lane C4 (persist lane). Optional until C4 deploys. */
  REPORTS?: R2Bucket;
}
