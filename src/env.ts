// Muat backend/.env sebelum modul lain dibaca (Node ≥ 20.12)
try {
  process.loadEnvFile?.('.env');
} catch {
  /* .env opsional — environment bisa di-set dari luar */
}
