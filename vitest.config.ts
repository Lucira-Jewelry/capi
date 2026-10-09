import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests that talk to the Firestore emulator do many sequential database calls, and the emulator slows down as test
    // brands pile up in it, so the 5 second default is too tight for them.
    testTimeout: 20_000,
  },
});
