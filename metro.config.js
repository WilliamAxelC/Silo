const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Ignore Android build output directories to prevent Windows ENOENT watch errors during Gradle builds
const blockList = [
  /.*\/android\/build\/.*/,
  /.*\/android\/app\/build\/.*/,
  /.*\/android\/\.gradle\/.*/,
];

if (Array.isArray(config.resolver.blockList)) {
  config.resolver.blockList.push(...blockList);
} else if (config.resolver.blockList) {
  config.resolver.blockList = [config.resolver.blockList, ...blockList];
} else {
  config.resolver.blockList = blockList;
}

module.exports = config;
