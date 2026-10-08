// https://docs.expo.dev/versions/v57.0.0/config/metro/
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// .claude/worktrees holds crew copies of this repo, each with its own node_modules. Keep Metro from
// crawling them when it runs from the main checkout. The pattern is anchored to this project root,
// so Metro running inside one of those worktrees still sees its own files.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const root = __dirname.split(/[\\/]/).map(escapeRegExp).join('[\\\\/]');
const crewWorktrees = new RegExp(`^(?:${root}[\\\\/])?\\.claude[\\\\/]worktrees(?:[\\\\/]|$)`, 'i');
config.resolver.blockList = [config.resolver.blockList ?? []].flat().concat(crewWorktrees);

module.exports = config;
