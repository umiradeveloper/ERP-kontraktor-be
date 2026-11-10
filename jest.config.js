// Unit test: src/ berakhiran .spec.ts — E2E: test/ berakhiran .e2e-spec.ts (butuh MySQL, lihat README)
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true, strictNullChecks: true, target: 'ES2022', module: 'commonjs' } }] },
  testRegex: process.env.E2E ? 'test/.*\\.e2e-spec\\.ts$' : 'src/.*\\.spec\\.ts$',
  testTimeout: 60000,
};
