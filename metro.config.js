// https://docs.expo.dev/versions/v57.0.0/config/metro/
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// .claude/worktrees holds crew copies of this repo, each with its own node_modules. Keep Metro from
// crawling them when it runs from the main checkout. The pattern is anchored to this project root,
// so Metro running inside one of those worktrees still sees its own files.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapedRoot = __dirname.split(/[\\/]/).map(escapeRegExp).join('[\\\\/]');
// No 'i' flag: Metro's own default blockList patterns carry no flags, and combining patterns
// with mismatched flags crashes Metro's file watcher ("Cannot combine blockList patterns,
// because they have different flags") - found when the m3-auth task ran `expo start --web`
// from inside a worktree. The one case difference that's actually plausible on Windows is the
// drive letter (tools disagree on "C:\" vs "c:\"), so make just that one character case-flexible
// instead of flagging the whole pattern.
const root = escapedRoot.replace(/^([A-Za-z])(?=:)/, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
const crewWorktrees = new RegExp(`^(?:${root}[\\\\/])?\\.claude[\\\\/]worktrees(?:[\\\\/]|$)`);
config.resolver.blockList = [config.resolver.blockList ?? []].flat().concat(crewWorktrees);

module.exports = config;
