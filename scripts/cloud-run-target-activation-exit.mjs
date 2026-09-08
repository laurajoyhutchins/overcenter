const EXIT_CODES = Object.freeze({
  '42501':13,
  '55000':14,
  POSTGRES_CONFIG_REQUIRED:16,
  ENOENT:17,
  ECONNREFUSED:18,
  ENOTFOUND:19,
  ETIMEDOUT:20,
  '25006':21,
  '28P01':22,
  '3D000':23,
  '42883':24,
  '42P01':25,
  '42704':26,
  '2BP01':27,
  '57P01':28,
  '08006':29,
  '08001':30,
  '53300':31,
});

export function classifiedActivationExitCode(error) {
  const code = String(error?.code || '');
  if (code.startsWith('TARGET_ACTIVATION_')) return 15;
  return EXIT_CODES[code] || 99;
}
