module.exports = {
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 5000,
    hookTimeout: 5000,
    reporters: 'default',
  },
};
