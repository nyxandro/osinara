#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/commander/lib/error.js
var require_error = __commonJS({
  "node_modules/commander/lib/error.js"(exports2) {
    var CommanderError2 = class extends Error {
      /**
       * Constructs the CommanderError class
       * @param {number} exitCode suggested exit code which could be used with process.exit
       * @param {string} code an id string representing the error
       * @param {string} message human-readable description of the error
       */
      constructor(exitCode, code, message) {
        super(message);
        Error.captureStackTrace(this, this.constructor);
        this.name = this.constructor.name;
        this.code = code;
        this.exitCode = exitCode;
        this.nestedError = void 0;
      }
    };
    var InvalidArgumentError2 = class extends CommanderError2 {
      /**
       * Constructs the InvalidArgumentError class
       * @param {string} [message] explanation of why argument is invalid
       */
      constructor(message) {
        super(1, "commander.invalidArgument", message);
        Error.captureStackTrace(this, this.constructor);
        this.name = this.constructor.name;
      }
    };
    exports2.CommanderError = CommanderError2;
    exports2.InvalidArgumentError = InvalidArgumentError2;
  }
});

// node_modules/commander/lib/argument.js
var require_argument = __commonJS({
  "node_modules/commander/lib/argument.js"(exports2) {
    var { InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var Argument2 = class {
      /**
       * Initialize a new command argument with the given name and description.
       * The default is that the argument is required, and you can explicitly
       * indicate this with <> around the name. Put [] around the name for an optional argument.
       *
       * @param {string} name
       * @param {string} [description]
       */
      constructor(name, description) {
        this.description = description || "";
        this.variadic = false;
        this.parseArg = void 0;
        this.defaultValue = void 0;
        this.defaultValueDescription = void 0;
        this.argChoices = void 0;
        switch (name[0]) {
          case "<":
            this.required = true;
            this._name = name.slice(1, -1);
            break;
          case "[":
            this.required = false;
            this._name = name.slice(1, -1);
            break;
          default:
            this.required = true;
            this._name = name;
            break;
        }
        if (this._name.endsWith("...")) {
          this.variadic = true;
          this._name = this._name.slice(0, -3);
        }
      }
      /**
       * Return argument name.
       *
       * @return {string}
       */
      name() {
        return this._name;
      }
      /**
       * @package
       */
      _collectValue(value, previous) {
        if (previous === this.defaultValue || !Array.isArray(previous)) {
          return [value];
        }
        previous.push(value);
        return previous;
      }
      /**
       * Set the default value, and optionally supply the description to be displayed in the help.
       *
       * @param {*} value
       * @param {string} [description]
       * @return {Argument}
       */
      default(value, description) {
        this.defaultValue = value;
        this.defaultValueDescription = description;
        return this;
      }
      /**
       * Set the custom handler for processing CLI command arguments into argument values.
       *
       * @param {Function} [fn]
       * @return {Argument}
       */
      argParser(fn) {
        this.parseArg = fn;
        return this;
      }
      /**
       * Only allow argument value to be one of choices.
       *
       * @param {string[]} values
       * @return {Argument}
       */
      choices(values) {
        this.argChoices = values.slice();
        this.parseArg = (arg, previous) => {
          if (!this.argChoices.includes(arg)) {
            throw new InvalidArgumentError2(
              `Allowed choices are ${this.argChoices.join(", ")}.`
            );
          }
          if (this.variadic) {
            return this._collectValue(arg, previous);
          }
          return arg;
        };
        return this;
      }
      /**
       * Make argument required.
       *
       * @returns {Argument}
       */
      argRequired() {
        this.required = true;
        return this;
      }
      /**
       * Make argument optional.
       *
       * @returns {Argument}
       */
      argOptional() {
        this.required = false;
        return this;
      }
    };
    function humanReadableArgName(arg) {
      const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
      return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
    }
    exports2.Argument = Argument2;
    exports2.humanReadableArgName = humanReadableArgName;
  }
});

// node_modules/commander/lib/help.js
var require_help = __commonJS({
  "node_modules/commander/lib/help.js"(exports2) {
    var { humanReadableArgName } = require_argument();
    var Help2 = class {
      constructor() {
        this.helpWidth = void 0;
        this.minWidthToWrap = 40;
        this.sortSubcommands = false;
        this.sortOptions = false;
        this.showGlobalOptions = false;
      }
      /**
       * prepareContext is called by Commander after applying overrides from `Command.configureHelp()`
       * and just before calling `formatHelp()`.
       *
       * Commander just uses the helpWidth and the rest is provided for optional use by more complex subclasses.
       *
       * @param {{ error?: boolean, helpWidth?: number, outputHasColors?: boolean }} contextOptions
       */
      prepareContext(contextOptions) {
        this.helpWidth = this.helpWidth ?? contextOptions.helpWidth ?? 80;
      }
      /**
       * Get an array of the visible subcommands. Includes a placeholder for the implicit help command, if there is one.
       *
       * @param {Command} cmd
       * @returns {Command[]}
       */
      visibleCommands(cmd) {
        const visibleCommands = cmd.commands.filter((cmd2) => !cmd2._hidden);
        const helpCommand = cmd._getHelpCommand();
        if (helpCommand && !helpCommand._hidden) {
          visibleCommands.push(helpCommand);
        }
        if (this.sortSubcommands) {
          visibleCommands.sort((a, b) => {
            return a.name().localeCompare(b.name());
          });
        }
        return visibleCommands;
      }
      /**
       * Compare options for sort.
       *
       * @param {Option} a
       * @param {Option} b
       * @returns {number}
       */
      compareOptions(a, b) {
        const getSortKey = (option) => {
          return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
        };
        return getSortKey(a).localeCompare(getSortKey(b));
      }
      /**
       * Get an array of the visible options. Includes a placeholder for the implicit help option, if there is one.
       *
       * @param {Command} cmd
       * @returns {Option[]}
       */
      visibleOptions(cmd) {
        const visibleOptions = cmd.options.filter((option) => !option.hidden);
        const helpOption = cmd._getHelpOption();
        if (helpOption && !helpOption.hidden) {
          const removeShort = helpOption.short && cmd._findOption(helpOption.short);
          const removeLong = helpOption.long && cmd._findOption(helpOption.long);
          if (!removeShort && !removeLong) {
            visibleOptions.push(helpOption);
          } else if (helpOption.long && !removeLong) {
            visibleOptions.push(
              cmd.createOption(helpOption.long, helpOption.description)
            );
          } else if (helpOption.short && !removeShort) {
            visibleOptions.push(
              cmd.createOption(helpOption.short, helpOption.description)
            );
          }
        }
        if (this.sortOptions) {
          visibleOptions.sort(this.compareOptions);
        }
        return visibleOptions;
      }
      /**
       * Get an array of the visible global options. (Not including help.)
       *
       * @param {Command} cmd
       * @returns {Option[]}
       */
      visibleGlobalOptions(cmd) {
        if (!this.showGlobalOptions) return [];
        const globalOptions = [];
        for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
          const visibleOptions = ancestorCmd.options.filter(
            (option) => !option.hidden
          );
          globalOptions.push(...visibleOptions);
        }
        if (this.sortOptions) {
          globalOptions.sort(this.compareOptions);
        }
        return globalOptions;
      }
      /**
       * Get an array of the arguments if any have a description.
       *
       * @param {Command} cmd
       * @returns {Argument[]}
       */
      visibleArguments(cmd) {
        if (cmd._argsDescription) {
          cmd.registeredArguments.forEach((argument) => {
            argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
          });
        }
        if (cmd.registeredArguments.find((argument) => argument.description)) {
          return cmd.registeredArguments;
        }
        return [];
      }
      /**
       * Get the command term to show in the list of subcommands.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      subcommandTerm(cmd) {
        const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
        return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + // simplistic check for non-help option
        (args ? " " + args : "");
      }
      /**
       * Get the option term to show in the list of options.
       *
       * @param {Option} option
       * @returns {string}
       */
      optionTerm(option) {
        return option.flags;
      }
      /**
       * Get the argument term to show in the list of arguments.
       *
       * @param {Argument} argument
       * @returns {string}
       */
      argumentTerm(argument) {
        return argument.name();
      }
      /**
       * Get the longest command term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestSubcommandTermLength(cmd, helper) {
        return helper.visibleCommands(cmd).reduce((max, command) => {
          return Math.max(
            max,
            this.displayWidth(
              helper.styleSubcommandTerm(helper.subcommandTerm(command))
            )
          );
        }, 0);
      }
      /**
       * Get the longest option term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestOptionTermLength(cmd, helper) {
        return helper.visibleOptions(cmd).reduce((max, option) => {
          return Math.max(
            max,
            this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option)))
          );
        }, 0);
      }
      /**
       * Get the longest global option term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestGlobalOptionTermLength(cmd, helper) {
        return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
          return Math.max(
            max,
            this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option)))
          );
        }, 0);
      }
      /**
       * Get the longest argument term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      longestArgumentTermLength(cmd, helper) {
        return helper.visibleArguments(cmd).reduce((max, argument) => {
          return Math.max(
            max,
            this.displayWidth(
              helper.styleArgumentTerm(helper.argumentTerm(argument))
            )
          );
        }, 0);
      }
      /**
       * Get the command usage to be displayed at the top of the built-in help.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      commandUsage(cmd) {
        let cmdName = cmd._name;
        if (cmd._aliases[0]) {
          cmdName = cmdName + "|" + cmd._aliases[0];
        }
        let ancestorCmdNames = "";
        for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
          ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
        }
        return ancestorCmdNames + cmdName + " " + cmd.usage();
      }
      /**
       * Get the description for the command.
       *
       * @param {Command} cmd
       * @returns {string}
       */
      commandDescription(cmd) {
        return cmd.description();
      }
      /**
       * Get the subcommand summary to show in the list of subcommands.
       * (Fallback to description for backwards compatibility.)
       *
       * @param {Command} cmd
       * @returns {string}
       */
      subcommandDescription(cmd) {
        return cmd.summary() || cmd.description();
      }
      /**
       * Get the option description to show in the list of options.
       *
       * @param {Option} option
       * @return {string}
       */
      optionDescription(option) {
        const extraInfo = [];
        if (option.argChoices) {
          extraInfo.push(
            // use stringify to match the display of the default value
            `choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
          );
        }
        if (option.defaultValue !== void 0) {
          const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
          if (showDefault) {
            extraInfo.push(
              `default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`
            );
          }
        }
        if (option.presetArg !== void 0 && option.optional) {
          extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
        }
        if (option.envVar !== void 0) {
          extraInfo.push(`env: ${option.envVar}`);
        }
        if (extraInfo.length > 0) {
          const extraDescription = `(${extraInfo.join(", ")})`;
          if (option.description) {
            return `${option.description} ${extraDescription}`;
          }
          return extraDescription;
        }
        return option.description;
      }
      /**
       * Get the argument description to show in the list of arguments.
       *
       * @param {Argument} argument
       * @return {string}
       */
      argumentDescription(argument) {
        const extraInfo = [];
        if (argument.argChoices) {
          extraInfo.push(
            // use stringify to match the display of the default value
            `choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
          );
        }
        if (argument.defaultValue !== void 0) {
          extraInfo.push(
            `default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`
          );
        }
        if (extraInfo.length > 0) {
          const extraDescription = `(${extraInfo.join(", ")})`;
          if (argument.description) {
            return `${argument.description} ${extraDescription}`;
          }
          return extraDescription;
        }
        return argument.description;
      }
      /**
       * Format a list of items, given a heading and an array of formatted items.
       *
       * @param {string} heading
       * @param {string[]} items
       * @param {Help} helper
       * @returns string[]
       */
      formatItemList(heading, items, helper) {
        if (items.length === 0) return [];
        return [helper.styleTitle(heading), ...items, ""];
      }
      /**
       * Group items by their help group heading.
       *
       * @param {Command[] | Option[]} unsortedItems
       * @param {Command[] | Option[]} visibleItems
       * @param {Function} getGroup
       * @returns {Map<string, Command[] | Option[]>}
       */
      groupItems(unsortedItems, visibleItems, getGroup) {
        const result = /* @__PURE__ */ new Map();
        unsortedItems.forEach((item) => {
          const group = getGroup(item);
          if (!result.has(group)) result.set(group, []);
        });
        visibleItems.forEach((item) => {
          const group = getGroup(item);
          if (!result.has(group)) {
            result.set(group, []);
          }
          result.get(group).push(item);
        });
        return result;
      }
      /**
       * Generate the built-in help text.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {string}
       */
      formatHelp(cmd, helper) {
        const termWidth = helper.padWidth(cmd, helper);
        const helpWidth = helper.helpWidth ?? 80;
        function callFormatItem(term, description) {
          return helper.formatItem(term, termWidth, description, helper);
        }
        let output = [
          `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
          ""
        ];
        const commandDescription = helper.commandDescription(cmd);
        if (commandDescription.length > 0) {
          output = output.concat([
            helper.boxWrap(
              helper.styleCommandDescription(commandDescription),
              helpWidth
            ),
            ""
          ]);
        }
        const argumentList = helper.visibleArguments(cmd).map((argument) => {
          return callFormatItem(
            helper.styleArgumentTerm(helper.argumentTerm(argument)),
            helper.styleArgumentDescription(helper.argumentDescription(argument))
          );
        });
        output = output.concat(
          this.formatItemList("Arguments:", argumentList, helper)
        );
        const optionGroups = this.groupItems(
          cmd.options,
          helper.visibleOptions(cmd),
          (option) => option.helpGroupHeading ?? "Options:"
        );
        optionGroups.forEach((options, group) => {
          const optionList = options.map((option) => {
            return callFormatItem(
              helper.styleOptionTerm(helper.optionTerm(option)),
              helper.styleOptionDescription(helper.optionDescription(option))
            );
          });
          output = output.concat(this.formatItemList(group, optionList, helper));
        });
        if (helper.showGlobalOptions) {
          const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
            return callFormatItem(
              helper.styleOptionTerm(helper.optionTerm(option)),
              helper.styleOptionDescription(helper.optionDescription(option))
            );
          });
          output = output.concat(
            this.formatItemList("Global Options:", globalOptionList, helper)
          );
        }
        const commandGroups = this.groupItems(
          cmd.commands,
          helper.visibleCommands(cmd),
          (sub) => sub.helpGroup() || "Commands:"
        );
        commandGroups.forEach((commands, group) => {
          const commandList = commands.map((sub) => {
            return callFormatItem(
              helper.styleSubcommandTerm(helper.subcommandTerm(sub)),
              helper.styleSubcommandDescription(helper.subcommandDescription(sub))
            );
          });
          output = output.concat(this.formatItemList(group, commandList, helper));
        });
        return output.join("\n");
      }
      /**
       * Return display width of string, ignoring ANSI escape sequences. Used in padding and wrapping calculations.
       *
       * @param {string} str
       * @returns {number}
       */
      displayWidth(str) {
        return stripColor(str).length;
      }
      /**
       * Style the title for displaying in the help. Called with 'Usage:', 'Options:', etc.
       *
       * @param {string} str
       * @returns {string}
       */
      styleTitle(str) {
        return str;
      }
      styleUsage(str) {
        return str.split(" ").map((word) => {
          if (word === "[options]") return this.styleOptionText(word);
          if (word === "[command]") return this.styleSubcommandText(word);
          if (word[0] === "[" || word[0] === "<")
            return this.styleArgumentText(word);
          return this.styleCommandText(word);
        }).join(" ");
      }
      styleCommandDescription(str) {
        return this.styleDescriptionText(str);
      }
      styleOptionDescription(str) {
        return this.styleDescriptionText(str);
      }
      styleSubcommandDescription(str) {
        return this.styleDescriptionText(str);
      }
      styleArgumentDescription(str) {
        return this.styleDescriptionText(str);
      }
      styleDescriptionText(str) {
        return str;
      }
      styleOptionTerm(str) {
        return this.styleOptionText(str);
      }
      styleSubcommandTerm(str) {
        return str.split(" ").map((word) => {
          if (word === "[options]") return this.styleOptionText(word);
          if (word[0] === "[" || word[0] === "<")
            return this.styleArgumentText(word);
          return this.styleSubcommandText(word);
        }).join(" ");
      }
      styleArgumentTerm(str) {
        return this.styleArgumentText(str);
      }
      styleOptionText(str) {
        return str;
      }
      styleArgumentText(str) {
        return str;
      }
      styleSubcommandText(str) {
        return str;
      }
      styleCommandText(str) {
        return str;
      }
      /**
       * Calculate the pad width from the maximum term length.
       *
       * @param {Command} cmd
       * @param {Help} helper
       * @returns {number}
       */
      padWidth(cmd, helper) {
        return Math.max(
          helper.longestOptionTermLength(cmd, helper),
          helper.longestGlobalOptionTermLength(cmd, helper),
          helper.longestSubcommandTermLength(cmd, helper),
          helper.longestArgumentTermLength(cmd, helper)
        );
      }
      /**
       * Detect manually wrapped and indented strings by checking for line break followed by whitespace.
       *
       * @param {string} str
       * @returns {boolean}
       */
      preformatted(str) {
        return /\n[^\S\r\n]/.test(str);
      }
      /**
       * Format the "item", which consists of a term and description. Pad the term and wrap the description, indenting the following lines.
       *
       * So "TTT", 5, "DDD DDDD DD DDD" might be formatted for this.helpWidth=17 like so:
       *   TTT  DDD DDDD
       *        DD DDD
       *
       * @param {string} term
       * @param {number} termWidth
       * @param {string} description
       * @param {Help} helper
       * @returns {string}
       */
      formatItem(term, termWidth, description, helper) {
        const itemIndent = 2;
        const itemIndentStr = " ".repeat(itemIndent);
        if (!description) return itemIndentStr + term;
        const paddedTerm = term.padEnd(
          termWidth + term.length - helper.displayWidth(term)
        );
        const spacerWidth = 2;
        const helpWidth = this.helpWidth ?? 80;
        const remainingWidth = helpWidth - termWidth - spacerWidth - itemIndent;
        let formattedDescription;
        if (remainingWidth < this.minWidthToWrap || helper.preformatted(description)) {
          formattedDescription = description;
        } else {
          const wrappedDescription = helper.boxWrap(description, remainingWidth);
          formattedDescription = wrappedDescription.replace(
            /\n/g,
            "\n" + " ".repeat(termWidth + spacerWidth)
          );
        }
        return itemIndentStr + paddedTerm + " ".repeat(spacerWidth) + formattedDescription.replace(/\n/g, `
${itemIndentStr}`);
      }
      /**
       * Wrap a string at whitespace, preserving existing line breaks.
       * Wrapping is skipped if the width is less than `minWidthToWrap`.
       *
       * @param {string} str
       * @param {number} width
       * @returns {string}
       */
      boxWrap(str, width) {
        if (width < this.minWidthToWrap) return str;
        const rawLines = str.split(/\r\n|\n/);
        const chunkPattern = /[\s]*[^\s]+/g;
        const wrappedLines = [];
        rawLines.forEach((line) => {
          const chunks = line.match(chunkPattern);
          if (chunks === null) {
            wrappedLines.push("");
            return;
          }
          let sumChunks = [chunks.shift()];
          let sumWidth = this.displayWidth(sumChunks[0]);
          chunks.forEach((chunk) => {
            const visibleWidth = this.displayWidth(chunk);
            if (sumWidth + visibleWidth <= width) {
              sumChunks.push(chunk);
              sumWidth += visibleWidth;
              return;
            }
            wrappedLines.push(sumChunks.join(""));
            const nextChunk = chunk.trimStart();
            sumChunks = [nextChunk];
            sumWidth = this.displayWidth(nextChunk);
          });
          wrappedLines.push(sumChunks.join(""));
        });
        return wrappedLines.join("\n");
      }
    };
    function stripColor(str) {
      const sgrPattern = /\x1b\[\d*(;\d*)*m/g;
      return str.replace(sgrPattern, "");
    }
    exports2.Help = Help2;
    exports2.stripColor = stripColor;
  }
});

// node_modules/commander/lib/option.js
var require_option = __commonJS({
  "node_modules/commander/lib/option.js"(exports2) {
    var { InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var Option2 = class {
      /**
       * Initialize a new `Option` with the given `flags` and `description`.
       *
       * @param {string} flags
       * @param {string} [description]
       */
      constructor(flags, description) {
        this.flags = flags;
        this.description = description || "";
        this.required = flags.includes("<");
        this.optional = flags.includes("[");
        this.variadic = /\w\.\.\.[>\]]$/.test(flags);
        this.mandatory = false;
        const optionFlags = splitOptionFlags(flags);
        this.short = optionFlags.shortFlag;
        this.long = optionFlags.longFlag;
        this.negate = false;
        if (this.long) {
          this.negate = this.long.startsWith("--no-");
        }
        this.defaultValue = void 0;
        this.defaultValueDescription = void 0;
        this.presetArg = void 0;
        this.envVar = void 0;
        this.parseArg = void 0;
        this.hidden = false;
        this.argChoices = void 0;
        this.conflictsWith = [];
        this.implied = void 0;
        this.helpGroupHeading = void 0;
      }
      /**
       * Set the default value, and optionally supply the description to be displayed in the help.
       *
       * @param {*} value
       * @param {string} [description]
       * @return {Option}
       */
      default(value, description) {
        this.defaultValue = value;
        this.defaultValueDescription = description;
        return this;
      }
      /**
       * Preset to use when option used without option-argument, especially optional but also boolean and negated.
       * The custom processing (parseArg) is called.
       *
       * @example
       * new Option('--color').default('GREYSCALE').preset('RGB');
       * new Option('--donate [amount]').preset('20').argParser(parseFloat);
       *
       * @param {*} arg
       * @return {Option}
       */
      preset(arg) {
        this.presetArg = arg;
        return this;
      }
      /**
       * Add option name(s) that conflict with this option.
       * An error will be displayed if conflicting options are found during parsing.
       *
       * @example
       * new Option('--rgb').conflicts('cmyk');
       * new Option('--js').conflicts(['ts', 'jsx']);
       *
       * @param {(string | string[])} names
       * @return {Option}
       */
      conflicts(names) {
        this.conflictsWith = this.conflictsWith.concat(names);
        return this;
      }
      /**
       * Specify implied option values for when this option is set and the implied options are not.
       *
       * The custom processing (parseArg) is not called on the implied values.
       *
       * @example
       * program
       *   .addOption(new Option('--log', 'write logging information to file'))
       *   .addOption(new Option('--trace', 'log extra details').implies({ log: 'trace.txt' }));
       *
       * @param {object} impliedOptionValues
       * @return {Option}
       */
      implies(impliedOptionValues) {
        let newImplied = impliedOptionValues;
        if (typeof impliedOptionValues === "string") {
          newImplied = { [impliedOptionValues]: true };
        }
        this.implied = Object.assign(this.implied || {}, newImplied);
        return this;
      }
      /**
       * Set environment variable to check for option value.
       *
       * An environment variable is only used if when processed the current option value is
       * undefined, or the source of the current value is 'default' or 'config' or 'env'.
       *
       * @param {string} name
       * @return {Option}
       */
      env(name) {
        this.envVar = name;
        return this;
      }
      /**
       * Set the custom handler for processing CLI option arguments into option values.
       *
       * @param {Function} [fn]
       * @return {Option}
       */
      argParser(fn) {
        this.parseArg = fn;
        return this;
      }
      /**
       * Whether the option is mandatory and must have a value after parsing.
       *
       * @param {boolean} [mandatory=true]
       * @return {Option}
       */
      makeOptionMandatory(mandatory = true) {
        this.mandatory = !!mandatory;
        return this;
      }
      /**
       * Hide option in help.
       *
       * @param {boolean} [hide=true]
       * @return {Option}
       */
      hideHelp(hide = true) {
        this.hidden = !!hide;
        return this;
      }
      /**
       * @package
       */
      _collectValue(value, previous) {
        if (previous === this.defaultValue || !Array.isArray(previous)) {
          return [value];
        }
        previous.push(value);
        return previous;
      }
      /**
       * Only allow option value to be one of choices.
       *
       * @param {string[]} values
       * @return {Option}
       */
      choices(values) {
        this.argChoices = values.slice();
        this.parseArg = (arg, previous) => {
          if (!this.argChoices.includes(arg)) {
            throw new InvalidArgumentError2(
              `Allowed choices are ${this.argChoices.join(", ")}.`
            );
          }
          if (this.variadic) {
            return this._collectValue(arg, previous);
          }
          return arg;
        };
        return this;
      }
      /**
       * Return option name.
       *
       * @return {string}
       */
      name() {
        if (this.long) {
          return this.long.replace(/^--/, "");
        }
        return this.short.replace(/^-/, "");
      }
      /**
       * Return option name, in a camelcase format that can be used
       * as an object attribute key.
       *
       * @return {string}
       */
      attributeName() {
        if (this.negate) {
          return camelcase(this.name().replace(/^no-/, ""));
        }
        return camelcase(this.name());
      }
      /**
       * Set the help group heading.
       *
       * @param {string} heading
       * @return {Option}
       */
      helpGroup(heading) {
        this.helpGroupHeading = heading;
        return this;
      }
      /**
       * Check if `arg` matches the short or long flag.
       *
       * @param {string} arg
       * @return {boolean}
       * @package
       */
      is(arg) {
        return this.short === arg || this.long === arg;
      }
      /**
       * Return whether a boolean option.
       *
       * Options are one of boolean, negated, required argument, or optional argument.
       *
       * @return {boolean}
       * @package
       */
      isBoolean() {
        return !this.required && !this.optional && !this.negate;
      }
    };
    var DualOptions = class {
      /**
       * @param {Option[]} options
       */
      constructor(options) {
        this.positiveOptions = /* @__PURE__ */ new Map();
        this.negativeOptions = /* @__PURE__ */ new Map();
        this.dualOptions = /* @__PURE__ */ new Set();
        options.forEach((option) => {
          if (option.negate) {
            this.negativeOptions.set(option.attributeName(), option);
          } else {
            this.positiveOptions.set(option.attributeName(), option);
          }
        });
        this.negativeOptions.forEach((value, key) => {
          if (this.positiveOptions.has(key)) {
            this.dualOptions.add(key);
          }
        });
      }
      /**
       * Did the value come from the option, and not from possible matching dual option?
       *
       * @param {*} value
       * @param {Option} option
       * @returns {boolean}
       */
      valueFromOption(value, option) {
        const optionKey = option.attributeName();
        if (!this.dualOptions.has(optionKey)) return true;
        const preset = this.negativeOptions.get(optionKey).presetArg;
        const negativeValue = preset !== void 0 ? preset : false;
        return option.negate === (negativeValue === value);
      }
    };
    function camelcase(str) {
      return str.split("-").reduce((str2, word) => {
        return str2 + word[0].toUpperCase() + word.slice(1);
      });
    }
    function splitOptionFlags(flags) {
      let shortFlag;
      let longFlag;
      const shortFlagExp = /^-[^-]$/;
      const longFlagExp = /^--[^-]/;
      const flagParts = flags.split(/[ |,]+/).concat("guard");
      if (shortFlagExp.test(flagParts[0])) shortFlag = flagParts.shift();
      if (longFlagExp.test(flagParts[0])) longFlag = flagParts.shift();
      if (!shortFlag && shortFlagExp.test(flagParts[0]))
        shortFlag = flagParts.shift();
      if (!shortFlag && longFlagExp.test(flagParts[0])) {
        shortFlag = longFlag;
        longFlag = flagParts.shift();
      }
      if (flagParts[0].startsWith("-")) {
        const unsupportedFlag = flagParts[0];
        const baseError = `option creation failed due to '${unsupportedFlag}' in option flags '${flags}'`;
        if (/^-[^-][^-]/.test(unsupportedFlag))
          throw new Error(
            `${baseError}
- a short flag is a single dash and a single character
  - either use a single dash and a single character (for a short flag)
  - or use a double dash for a long option (and can have two, like '--ws, --workspace')`
          );
        if (shortFlagExp.test(unsupportedFlag))
          throw new Error(`${baseError}
- too many short flags`);
        if (longFlagExp.test(unsupportedFlag))
          throw new Error(`${baseError}
- too many long flags`);
        throw new Error(`${baseError}
- unrecognised flag format`);
      }
      if (shortFlag === void 0 && longFlag === void 0)
        throw new Error(
          `option creation failed due to no flags found in '${flags}'.`
        );
      return { shortFlag, longFlag };
    }
    exports2.Option = Option2;
    exports2.DualOptions = DualOptions;
  }
});

// node_modules/commander/lib/suggestSimilar.js
var require_suggestSimilar = __commonJS({
  "node_modules/commander/lib/suggestSimilar.js"(exports2) {
    var maxDistance = 3;
    function editDistance(a, b) {
      if (Math.abs(a.length - b.length) > maxDistance)
        return Math.max(a.length, b.length);
      const d = [];
      for (let i = 0; i <= a.length; i++) {
        d[i] = [i];
      }
      for (let j = 0; j <= b.length; j++) {
        d[0][j] = j;
      }
      for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
          let cost = 1;
          if (a[i - 1] === b[j - 1]) {
            cost = 0;
          } else {
            cost = 1;
          }
          d[i][j] = Math.min(
            d[i - 1][j] + 1,
            // deletion
            d[i][j - 1] + 1,
            // insertion
            d[i - 1][j - 1] + cost
            // substitution
          );
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
            d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
          }
        }
      }
      return d[a.length][b.length];
    }
    function suggestSimilar(word, candidates) {
      if (!candidates || candidates.length === 0) return "";
      candidates = Array.from(new Set(candidates));
      const searchingOptions = word.startsWith("--");
      if (searchingOptions) {
        word = word.slice(2);
        candidates = candidates.map((candidate) => candidate.slice(2));
      }
      let similar = [];
      let bestDistance = maxDistance;
      const minSimilarity = 0.4;
      candidates.forEach((candidate) => {
        if (candidate.length <= 1) return;
        const distance = editDistance(word, candidate);
        const length = Math.max(word.length, candidate.length);
        const similarity = (length - distance) / length;
        if (similarity > minSimilarity) {
          if (distance < bestDistance) {
            bestDistance = distance;
            similar = [candidate];
          } else if (distance === bestDistance) {
            similar.push(candidate);
          }
        }
      });
      similar.sort((a, b) => a.localeCompare(b));
      if (searchingOptions) {
        similar = similar.map((candidate) => `--${candidate}`);
      }
      if (similar.length > 1) {
        return `
(Did you mean one of ${similar.join(", ")}?)`;
      }
      if (similar.length === 1) {
        return `
(Did you mean ${similar[0]}?)`;
      }
      return "";
    }
    exports2.suggestSimilar = suggestSimilar;
  }
});

// node_modules/commander/lib/command.js
var require_command = __commonJS({
  "node_modules/commander/lib/command.js"(exports2) {
    var EventEmitter = require("node:events").EventEmitter;
    var childProcess = require("node:child_process");
    var path8 = require("node:path");
    var fs6 = require("node:fs");
    var process2 = require("node:process");
    var { Argument: Argument2, humanReadableArgName } = require_argument();
    var { CommanderError: CommanderError2 } = require_error();
    var { Help: Help2, stripColor } = require_help();
    var { Option: Option2, DualOptions } = require_option();
    var { suggestSimilar } = require_suggestSimilar();
    var Command2 = class _Command extends EventEmitter {
      /**
       * Initialize a new `Command`.
       *
       * @param {string} [name]
       */
      constructor(name) {
        super();
        this.commands = [];
        this.options = [];
        this.parent = null;
        this._allowUnknownOption = false;
        this._allowExcessArguments = false;
        this.registeredArguments = [];
        this._args = this.registeredArguments;
        this.args = [];
        this.rawArgs = [];
        this.processedArgs = [];
        this._scriptPath = null;
        this._name = name || "";
        this._optionValues = {};
        this._optionValueSources = {};
        this._storeOptionsAsProperties = false;
        this._actionHandler = null;
        this._executableHandler = false;
        this._executableFile = null;
        this._executableDir = null;
        this._defaultCommandName = null;
        this._exitCallback = null;
        this._aliases = [];
        this._combineFlagAndOptionalValue = true;
        this._description = "";
        this._summary = "";
        this._argsDescription = void 0;
        this._enablePositionalOptions = false;
        this._passThroughOptions = false;
        this._lifeCycleHooks = {};
        this._showHelpAfterError = false;
        this._showSuggestionAfterError = true;
        this._savedState = null;
        this._outputConfiguration = {
          writeOut: (str) => process2.stdout.write(str),
          writeErr: (str) => process2.stderr.write(str),
          outputError: (str, write) => write(str),
          getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : void 0,
          getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : void 0,
          getOutHasColors: () => useColor() ?? (process2.stdout.isTTY && process2.stdout.hasColors?.()),
          getErrHasColors: () => useColor() ?? (process2.stderr.isTTY && process2.stderr.hasColors?.()),
          stripColor: (str) => stripColor(str)
        };
        this._hidden = false;
        this._helpOption = void 0;
        this._addImplicitHelpCommand = void 0;
        this._helpCommand = void 0;
        this._helpConfiguration = {};
        this._helpGroupHeading = void 0;
        this._defaultCommandGroup = void 0;
        this._defaultOptionGroup = void 0;
      }
      /**
       * Copy settings that are useful to have in common across root command and subcommands.
       *
       * (Used internally when adding a command using `.command()` so subcommands inherit parent settings.)
       *
       * @param {Command} sourceCommand
       * @return {Command} `this` command for chaining
       */
      copyInheritedSettings(sourceCommand) {
        this._outputConfiguration = sourceCommand._outputConfiguration;
        this._helpOption = sourceCommand._helpOption;
        this._helpCommand = sourceCommand._helpCommand;
        this._helpConfiguration = sourceCommand._helpConfiguration;
        this._exitCallback = sourceCommand._exitCallback;
        this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
        this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
        this._allowExcessArguments = sourceCommand._allowExcessArguments;
        this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
        this._showHelpAfterError = sourceCommand._showHelpAfterError;
        this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
        return this;
      }
      /**
       * @returns {Command[]}
       * @private
       */
      _getCommandAndAncestors() {
        const result = [];
        for (let command = this; command; command = command.parent) {
          result.push(command);
        }
        return result;
      }
      /**
       * Define a command.
       *
       * There are two styles of command: pay attention to where to put the description.
       *
       * @example
       * // Command implemented using action handler (description is supplied separately to `.command`)
       * program
       *   .command('clone <source> [destination]')
       *   .description('clone a repository into a newly created directory')
       *   .action((source, destination) => {
       *     console.log('clone command called');
       *   });
       *
       * // Command implemented using separate executable file (description is second parameter to `.command`)
       * program
       *   .command('start <service>', 'start named service')
       *   .command('stop [service]', 'stop named service, or all if no name supplied');
       *
       * @param {string} nameAndArgs - command name and arguments, args are `<required>` or `[optional]` and last may also be `variadic...`
       * @param {(object | string)} [actionOptsOrExecDesc] - configuration options (for action), or description (for executable)
       * @param {object} [execOpts] - configuration options (for executable)
       * @return {Command} returns new command for action handler, or `this` for executable command
       */
      command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
        let desc = actionOptsOrExecDesc;
        let opts = execOpts;
        if (typeof desc === "object" && desc !== null) {
          opts = desc;
          desc = null;
        }
        opts = opts || {};
        const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
        const cmd = this.createCommand(name);
        if (desc) {
          cmd.description(desc);
          cmd._executableHandler = true;
        }
        if (opts.isDefault) this._defaultCommandName = cmd._name;
        cmd._hidden = !!(opts.noHelp || opts.hidden);
        cmd._executableFile = opts.executableFile || null;
        if (args) cmd.arguments(args);
        this._registerCommand(cmd);
        cmd.parent = this;
        cmd.copyInheritedSettings(this);
        if (desc) return this;
        return cmd;
      }
      /**
       * Factory routine to create a new unattached command.
       *
       * See .command() for creating an attached subcommand, which uses this routine to
       * create the command. You can override createCommand to customise subcommands.
       *
       * @param {string} [name]
       * @return {Command} new command
       */
      createCommand(name) {
        return new _Command(name);
      }
      /**
       * You can customise the help with a subclass of Help by overriding createHelp,
       * or by overriding Help properties using configureHelp().
       *
       * @return {Help}
       */
      createHelp() {
        return Object.assign(new Help2(), this.configureHelp());
      }
      /**
       * You can customise the help by overriding Help properties using configureHelp(),
       * or with a subclass of Help by overriding createHelp().
       *
       * @param {object} [configuration] - configuration options
       * @return {(Command | object)} `this` command for chaining, or stored configuration
       */
      configureHelp(configuration) {
        if (configuration === void 0) return this._helpConfiguration;
        this._helpConfiguration = configuration;
        return this;
      }
      /**
       * The default output goes to stdout and stderr. You can customise this for special
       * applications. You can also customise the display of errors by overriding outputError.
       *
       * The configuration properties are all functions:
       *
       *     // change how output being written, defaults to stdout and stderr
       *     writeOut(str)
       *     writeErr(str)
       *     // change how output being written for errors, defaults to writeErr
       *     outputError(str, write) // used for displaying errors and not used for displaying help
       *     // specify width for wrapping help
       *     getOutHelpWidth()
       *     getErrHelpWidth()
       *     // color support, currently only used with Help
       *     getOutHasColors()
       *     getErrHasColors()
       *     stripColor() // used to remove ANSI escape codes if output does not have colors
       *
       * @param {object} [configuration] - configuration options
       * @return {(Command | object)} `this` command for chaining, or stored configuration
       */
      configureOutput(configuration) {
        if (configuration === void 0) return this._outputConfiguration;
        this._outputConfiguration = {
          ...this._outputConfiguration,
          ...configuration
        };
        return this;
      }
      /**
       * Display the help or a custom message after an error occurs.
       *
       * @param {(boolean|string)} [displayHelp]
       * @return {Command} `this` command for chaining
       */
      showHelpAfterError(displayHelp = true) {
        if (typeof displayHelp !== "string") displayHelp = !!displayHelp;
        this._showHelpAfterError = displayHelp;
        return this;
      }
      /**
       * Display suggestion of similar commands for unknown commands, or options for unknown options.
       *
       * @param {boolean} [displaySuggestion]
       * @return {Command} `this` command for chaining
       */
      showSuggestionAfterError(displaySuggestion = true) {
        this._showSuggestionAfterError = !!displaySuggestion;
        return this;
      }
      /**
       * Add a prepared subcommand.
       *
       * See .command() for creating an attached subcommand which inherits settings from its parent.
       *
       * @param {Command} cmd - new subcommand
       * @param {object} [opts] - configuration options
       * @return {Command} `this` command for chaining
       */
      addCommand(cmd, opts) {
        if (!cmd._name) {
          throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
        }
        opts = opts || {};
        if (opts.isDefault) this._defaultCommandName = cmd._name;
        if (opts.noHelp || opts.hidden) cmd._hidden = true;
        this._registerCommand(cmd);
        cmd.parent = this;
        cmd._checkForBrokenPassThrough();
        return this;
      }
      /**
       * Factory routine to create a new unattached argument.
       *
       * See .argument() for creating an attached argument, which uses this routine to
       * create the argument. You can override createArgument to return a custom argument.
       *
       * @param {string} name
       * @param {string} [description]
       * @return {Argument} new argument
       */
      createArgument(name, description) {
        return new Argument2(name, description);
      }
      /**
       * Define argument syntax for command.
       *
       * The default is that the argument is required, and you can explicitly
       * indicate this with <> around the name. Put [] around the name for an optional argument.
       *
       * @example
       * program.argument('<input-file>');
       * program.argument('[output-file]');
       *
       * @param {string} name
       * @param {string} [description]
       * @param {(Function|*)} [parseArg] - custom argument processing function or default value
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      argument(name, description, parseArg, defaultValue) {
        const argument = this.createArgument(name, description);
        if (typeof parseArg === "function") {
          argument.default(defaultValue).argParser(parseArg);
        } else {
          argument.default(parseArg);
        }
        this.addArgument(argument);
        return this;
      }
      /**
       * Define argument syntax for command, adding multiple at once (without descriptions).
       *
       * See also .argument().
       *
       * @example
       * program.arguments('<cmd> [env]');
       *
       * @param {string} names
       * @return {Command} `this` command for chaining
       */
      arguments(names) {
        names.trim().split(/ +/).forEach((detail) => {
          this.argument(detail);
        });
        return this;
      }
      /**
       * Define argument syntax for command, adding a prepared argument.
       *
       * @param {Argument} argument
       * @return {Command} `this` command for chaining
       */
      addArgument(argument) {
        const previousArgument = this.registeredArguments.slice(-1)[0];
        if (previousArgument?.variadic) {
          throw new Error(
            `only the last argument can be variadic '${previousArgument.name()}'`
          );
        }
        if (argument.required && argument.defaultValue !== void 0 && argument.parseArg === void 0) {
          throw new Error(
            `a default value for a required argument is never used: '${argument.name()}'`
          );
        }
        this.registeredArguments.push(argument);
        return this;
      }
      /**
       * Customise or override default help command. By default a help command is automatically added if your command has subcommands.
       *
       * @example
       *    program.helpCommand('help [cmd]');
       *    program.helpCommand('help [cmd]', 'show help');
       *    program.helpCommand(false); // suppress default help command
       *    program.helpCommand(true); // add help command even if no subcommands
       *
       * @param {string|boolean} enableOrNameAndArgs - enable with custom name and/or arguments, or boolean to override whether added
       * @param {string} [description] - custom description
       * @return {Command} `this` command for chaining
       */
      helpCommand(enableOrNameAndArgs, description) {
        if (typeof enableOrNameAndArgs === "boolean") {
          this._addImplicitHelpCommand = enableOrNameAndArgs;
          if (enableOrNameAndArgs && this._defaultCommandGroup) {
            this._initCommandGroup(this._getHelpCommand());
          }
          return this;
        }
        const nameAndArgs = enableOrNameAndArgs ?? "help [command]";
        const [, helpName, helpArgs] = nameAndArgs.match(/([^ ]+) *(.*)/);
        const helpDescription = description ?? "display help for command";
        const helpCommand = this.createCommand(helpName);
        helpCommand.helpOption(false);
        if (helpArgs) helpCommand.arguments(helpArgs);
        if (helpDescription) helpCommand.description(helpDescription);
        this._addImplicitHelpCommand = true;
        this._helpCommand = helpCommand;
        if (enableOrNameAndArgs || description) this._initCommandGroup(helpCommand);
        return this;
      }
      /**
       * Add prepared custom help command.
       *
       * @param {(Command|string|boolean)} helpCommand - custom help command, or deprecated enableOrNameAndArgs as for `.helpCommand()`
       * @param {string} [deprecatedDescription] - deprecated custom description used with custom name only
       * @return {Command} `this` command for chaining
       */
      addHelpCommand(helpCommand, deprecatedDescription) {
        if (typeof helpCommand !== "object") {
          this.helpCommand(helpCommand, deprecatedDescription);
          return this;
        }
        this._addImplicitHelpCommand = true;
        this._helpCommand = helpCommand;
        this._initCommandGroup(helpCommand);
        return this;
      }
      /**
       * Lazy create help command.
       *
       * @return {(Command|null)}
       * @package
       */
      _getHelpCommand() {
        const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
        if (hasImplicitHelpCommand) {
          if (this._helpCommand === void 0) {
            this.helpCommand(void 0, void 0);
          }
          return this._helpCommand;
        }
        return null;
      }
      /**
       * Add hook for life cycle event.
       *
       * @param {string} event
       * @param {Function} listener
       * @return {Command} `this` command for chaining
       */
      hook(event, listener) {
        const allowedValues = ["preSubcommand", "preAction", "postAction"];
        if (!allowedValues.includes(event)) {
          throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
        }
        if (this._lifeCycleHooks[event]) {
          this._lifeCycleHooks[event].push(listener);
        } else {
          this._lifeCycleHooks[event] = [listener];
        }
        return this;
      }
      /**
       * Register callback to use as replacement for calling process.exit.
       *
       * @param {Function} [fn] optional callback which will be passed a CommanderError, defaults to throwing
       * @return {Command} `this` command for chaining
       */
      exitOverride(fn) {
        if (fn) {
          this._exitCallback = fn;
        } else {
          this._exitCallback = (err) => {
            if (err.code !== "commander.executeSubCommandAsync") {
              throw err;
            } else {
            }
          };
        }
        return this;
      }
      /**
       * Call process.exit, and _exitCallback if defined.
       *
       * @param {number} exitCode exit code for using with process.exit
       * @param {string} code an id string representing the error
       * @param {string} message human-readable description of the error
       * @return never
       * @private
       */
      _exit(exitCode, code, message) {
        if (this._exitCallback) {
          this._exitCallback(new CommanderError2(exitCode, code, message));
        }
        process2.exit(exitCode);
      }
      /**
       * Register callback `fn` for the command.
       *
       * @example
       * program
       *   .command('serve')
       *   .description('start service')
       *   .action(function() {
       *      // do work here
       *   });
       *
       * @param {Function} fn
       * @return {Command} `this` command for chaining
       */
      action(fn) {
        const listener = (args) => {
          const expectedArgsCount = this.registeredArguments.length;
          const actionArgs = args.slice(0, expectedArgsCount);
          if (this._storeOptionsAsProperties) {
            actionArgs[expectedArgsCount] = this;
          } else {
            actionArgs[expectedArgsCount] = this.opts();
          }
          actionArgs.push(this);
          return fn.apply(this, actionArgs);
        };
        this._actionHandler = listener;
        return this;
      }
      /**
       * Factory routine to create a new unattached option.
       *
       * See .option() for creating an attached option, which uses this routine to
       * create the option. You can override createOption to return a custom option.
       *
       * @param {string} flags
       * @param {string} [description]
       * @return {Option} new option
       */
      createOption(flags, description) {
        return new Option2(flags, description);
      }
      /**
       * Wrap parseArgs to catch 'commander.invalidArgument'.
       *
       * @param {(Option | Argument)} target
       * @param {string} value
       * @param {*} previous
       * @param {string} invalidArgumentMessage
       * @private
       */
      _callParseArg(target, value, previous, invalidArgumentMessage) {
        try {
          return target.parseArg(value, previous);
        } catch (err) {
          if (err.code === "commander.invalidArgument") {
            const message = `${invalidArgumentMessage} ${err.message}`;
            this.error(message, { exitCode: err.exitCode, code: err.code });
          }
          throw err;
        }
      }
      /**
       * Check for option flag conflicts.
       * Register option if no conflicts found, or throw on conflict.
       *
       * @param {Option} option
       * @private
       */
      _registerOption(option) {
        const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
        if (matchingOption) {
          const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
          throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
        }
        this._initOptionGroup(option);
        this.options.push(option);
      }
      /**
       * Check for command name and alias conflicts with existing commands.
       * Register command if no conflicts found, or throw on conflict.
       *
       * @param {Command} command
       * @private
       */
      _registerCommand(command) {
        const knownBy = (cmd) => {
          return [cmd.name()].concat(cmd.aliases());
        };
        const alreadyUsed = knownBy(command).find(
          (name) => this._findCommand(name)
        );
        if (alreadyUsed) {
          const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
          const newCmd = knownBy(command).join("|");
          throw new Error(
            `cannot add command '${newCmd}' as already have command '${existingCmd}'`
          );
        }
        this._initCommandGroup(command);
        this.commands.push(command);
      }
      /**
       * Add an option.
       *
       * @param {Option} option
       * @return {Command} `this` command for chaining
       */
      addOption(option) {
        this._registerOption(option);
        const oname = option.name();
        const name = option.attributeName();
        if (option.negate) {
          const positiveLongFlag = option.long.replace(/^--no-/, "--");
          if (!this._findOption(positiveLongFlag)) {
            this.setOptionValueWithSource(
              name,
              option.defaultValue === void 0 ? true : option.defaultValue,
              "default"
            );
          }
        } else if (option.defaultValue !== void 0) {
          this.setOptionValueWithSource(name, option.defaultValue, "default");
        }
        const handleOptionValue = (val, invalidValueMessage, valueSource) => {
          if (val == null && option.presetArg !== void 0) {
            val = option.presetArg;
          }
          const oldValue = this.getOptionValue(name);
          if (val !== null && option.parseArg) {
            val = this._callParseArg(option, val, oldValue, invalidValueMessage);
          } else if (val !== null && option.variadic) {
            val = option._collectValue(val, oldValue);
          }
          if (val == null) {
            if (option.negate) {
              val = false;
            } else if (option.isBoolean() || option.optional) {
              val = true;
            } else {
              val = "";
            }
          }
          this.setOptionValueWithSource(name, val, valueSource);
        };
        this.on("option:" + oname, (val) => {
          const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
          handleOptionValue(val, invalidValueMessage, "cli");
        });
        if (option.envVar) {
          this.on("optionEnv:" + oname, (val) => {
            const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
            handleOptionValue(val, invalidValueMessage, "env");
          });
        }
        return this;
      }
      /**
       * Internal implementation shared by .option() and .requiredOption()
       *
       * @return {Command} `this` command for chaining
       * @private
       */
      _optionEx(config, flags, description, fn, defaultValue) {
        if (typeof flags === "object" && flags instanceof Option2) {
          throw new Error(
            "To add an Option object use addOption() instead of option() or requiredOption()"
          );
        }
        const option = this.createOption(flags, description);
        option.makeOptionMandatory(!!config.mandatory);
        if (typeof fn === "function") {
          option.default(defaultValue).argParser(fn);
        } else if (fn instanceof RegExp) {
          const regex = fn;
          fn = (val, def) => {
            const m = regex.exec(val);
            return m ? m[0] : def;
          };
          option.default(defaultValue).argParser(fn);
        } else {
          option.default(fn);
        }
        return this.addOption(option);
      }
      /**
       * Define option with `flags`, `description`, and optional argument parsing function or `defaultValue` or both.
       *
       * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space. A required
       * option-argument is indicated by `<>` and an optional option-argument by `[]`.
       *
       * See the README for more details, and see also addOption() and requiredOption().
       *
       * @example
       * program
       *     .option('-p, --pepper', 'add pepper')
       *     .option('--pt, --pizza-type <TYPE>', 'type of pizza') // required option-argument
       *     .option('-c, --cheese [CHEESE]', 'add extra cheese', 'mozzarella') // optional option-argument with default
       *     .option('-t, --tip <VALUE>', 'add tip to purchase cost', parseFloat) // custom parse function
       *
       * @param {string} flags
       * @param {string} [description]
       * @param {(Function|*)} [parseArg] - custom option processing function or default value
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      option(flags, description, parseArg, defaultValue) {
        return this._optionEx({}, flags, description, parseArg, defaultValue);
      }
      /**
       * Add a required option which must have a value after parsing. This usually means
       * the option must be specified on the command line. (Otherwise the same as .option().)
       *
       * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space.
       *
       * @param {string} flags
       * @param {string} [description]
       * @param {(Function|*)} [parseArg] - custom option processing function or default value
       * @param {*} [defaultValue]
       * @return {Command} `this` command for chaining
       */
      requiredOption(flags, description, parseArg, defaultValue) {
        return this._optionEx(
          { mandatory: true },
          flags,
          description,
          parseArg,
          defaultValue
        );
      }
      /**
       * Alter parsing of short flags with optional values.
       *
       * @example
       * // for `.option('-f,--flag [value]'):
       * program.combineFlagAndOptionalValue(true);  // `-f80` is treated like `--flag=80`, this is the default behaviour
       * program.combineFlagAndOptionalValue(false) // `-fb` is treated like `-f -b`
       *
       * @param {boolean} [combine] - if `true` or omitted, an optional value can be specified directly after the flag.
       * @return {Command} `this` command for chaining
       */
      combineFlagAndOptionalValue(combine = true) {
        this._combineFlagAndOptionalValue = !!combine;
        return this;
      }
      /**
       * Allow unknown options on the command line.
       *
       * @param {boolean} [allowUnknown] - if `true` or omitted, no error will be thrown for unknown options.
       * @return {Command} `this` command for chaining
       */
      allowUnknownOption(allowUnknown = true) {
        this._allowUnknownOption = !!allowUnknown;
        return this;
      }
      /**
       * Allow excess command-arguments on the command line. Pass false to make excess arguments an error.
       *
       * @param {boolean} [allowExcess] - if `true` or omitted, no error will be thrown for excess arguments.
       * @return {Command} `this` command for chaining
       */
      allowExcessArguments(allowExcess = true) {
        this._allowExcessArguments = !!allowExcess;
        return this;
      }
      /**
       * Enable positional options. Positional means global options are specified before subcommands which lets
       * subcommands reuse the same option names, and also enables subcommands to turn on passThroughOptions.
       * The default behaviour is non-positional and global options may appear anywhere on the command line.
       *
       * @param {boolean} [positional]
       * @return {Command} `this` command for chaining
       */
      enablePositionalOptions(positional = true) {
        this._enablePositionalOptions = !!positional;
        return this;
      }
      /**
       * Pass through options that come after command-arguments rather than treat them as command-options,
       * so actual command-options come before command-arguments. Turning this on for a subcommand requires
       * positional options to have been enabled on the program (parent commands).
       * The default behaviour is non-positional and options may appear before or after command-arguments.
       *
       * @param {boolean} [passThrough] for unknown options.
       * @return {Command} `this` command for chaining
       */
      passThroughOptions(passThrough = true) {
        this._passThroughOptions = !!passThrough;
        this._checkForBrokenPassThrough();
        return this;
      }
      /**
       * @private
       */
      _checkForBrokenPassThrough() {
        if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
          throw new Error(
            `passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`
          );
        }
      }
      /**
       * Whether to store option values as properties on command object,
       * or store separately (specify false). In both cases the option values can be accessed using .opts().
       *
       * @param {boolean} [storeAsProperties=true]
       * @return {Command} `this` command for chaining
       */
      storeOptionsAsProperties(storeAsProperties = true) {
        if (this.options.length) {
          throw new Error("call .storeOptionsAsProperties() before adding options");
        }
        if (Object.keys(this._optionValues).length) {
          throw new Error(
            "call .storeOptionsAsProperties() before setting option values"
          );
        }
        this._storeOptionsAsProperties = !!storeAsProperties;
        return this;
      }
      /**
       * Retrieve option value.
       *
       * @param {string} key
       * @return {object} value
       */
      getOptionValue(key) {
        if (this._storeOptionsAsProperties) {
          return this[key];
        }
        return this._optionValues[key];
      }
      /**
       * Store option value.
       *
       * @param {string} key
       * @param {object} value
       * @return {Command} `this` command for chaining
       */
      setOptionValue(key, value) {
        return this.setOptionValueWithSource(key, value, void 0);
      }
      /**
       * Store option value and where the value came from.
       *
       * @param {string} key
       * @param {object} value
       * @param {string} source - expected values are default/config/env/cli/implied
       * @return {Command} `this` command for chaining
       */
      setOptionValueWithSource(key, value, source) {
        if (this._storeOptionsAsProperties) {
          this[key] = value;
        } else {
          this._optionValues[key] = value;
        }
        this._optionValueSources[key] = source;
        return this;
      }
      /**
       * Get source of option value.
       * Expected values are default | config | env | cli | implied
       *
       * @param {string} key
       * @return {string}
       */
      getOptionValueSource(key) {
        return this._optionValueSources[key];
      }
      /**
       * Get source of option value. See also .optsWithGlobals().
       * Expected values are default | config | env | cli | implied
       *
       * @param {string} key
       * @return {string}
       */
      getOptionValueSourceWithGlobals(key) {
        let source;
        this._getCommandAndAncestors().forEach((cmd) => {
          if (cmd.getOptionValueSource(key) !== void 0) {
            source = cmd.getOptionValueSource(key);
          }
        });
        return source;
      }
      /**
       * Get user arguments from implied or explicit arguments.
       * Side-effects: set _scriptPath if args included script. Used for default program name, and subcommand searches.
       *
       * @private
       */
      _prepareUserArgs(argv, parseOptions) {
        if (argv !== void 0 && !Array.isArray(argv)) {
          throw new Error("first parameter to parse must be array or undefined");
        }
        parseOptions = parseOptions || {};
        if (argv === void 0 && parseOptions.from === void 0) {
          if (process2.versions?.electron) {
            parseOptions.from = "electron";
          }
          const execArgv = process2.execArgv ?? [];
          if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
            parseOptions.from = "eval";
          }
        }
        if (argv === void 0) {
          argv = process2.argv;
        }
        this.rawArgs = argv.slice();
        let userArgs;
        switch (parseOptions.from) {
          case void 0:
          case "node":
            this._scriptPath = argv[1];
            userArgs = argv.slice(2);
            break;
          case "electron":
            if (process2.defaultApp) {
              this._scriptPath = argv[1];
              userArgs = argv.slice(2);
            } else {
              userArgs = argv.slice(1);
            }
            break;
          case "user":
            userArgs = argv.slice(0);
            break;
          case "eval":
            userArgs = argv.slice(1);
            break;
          default:
            throw new Error(
              `unexpected parse option { from: '${parseOptions.from}' }`
            );
        }
        if (!this._name && this._scriptPath)
          this.nameFromFilename(this._scriptPath);
        this._name = this._name || "program";
        return userArgs;
      }
      /**
       * Parse `argv`, setting options and invoking commands when defined.
       *
       * Use parseAsync instead of parse if any of your action handlers are async.
       *
       * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
       *
       * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
       * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
       * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
       * - `'user'`: just user arguments
       *
       * @example
       * program.parse(); // parse process.argv and auto-detect electron and special node flags
       * program.parse(process.argv); // assume argv[0] is app and argv[1] is script
       * program.parse(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
       *
       * @param {string[]} [argv] - optional, defaults to process.argv
       * @param {object} [parseOptions] - optionally specify style of options with from: node/user/electron
       * @param {string} [parseOptions.from] - where the args are from: 'node', 'user', 'electron'
       * @return {Command} `this` command for chaining
       */
      parse(argv, parseOptions) {
        this._prepareForParse();
        const userArgs = this._prepareUserArgs(argv, parseOptions);
        this._parseCommand([], userArgs);
        return this;
      }
      /**
       * Parse `argv`, setting options and invoking commands when defined.
       *
       * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
       *
       * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
       * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
       * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
       * - `'user'`: just user arguments
       *
       * @example
       * await program.parseAsync(); // parse process.argv and auto-detect electron and special node flags
       * await program.parseAsync(process.argv); // assume argv[0] is app and argv[1] is script
       * await program.parseAsync(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
       *
       * @param {string[]} [argv]
       * @param {object} [parseOptions]
       * @param {string} parseOptions.from - where the args are from: 'node', 'user', 'electron'
       * @return {Promise}
       */
      async parseAsync(argv, parseOptions) {
        this._prepareForParse();
        const userArgs = this._prepareUserArgs(argv, parseOptions);
        await this._parseCommand([], userArgs);
        return this;
      }
      _prepareForParse() {
        if (this._savedState === null) {
          this.saveStateBeforeParse();
        } else {
          this.restoreStateBeforeParse();
        }
      }
      /**
       * Called the first time parse is called to save state and allow a restore before subsequent calls to parse.
       * Not usually called directly, but available for subclasses to save their custom state.
       *
       * This is called in a lazy way. Only commands used in parsing chain will have state saved.
       */
      saveStateBeforeParse() {
        this._savedState = {
          // name is stable if supplied by author, but may be unspecified for root command and deduced during parsing
          _name: this._name,
          // option values before parse have default values (including false for negated options)
          // shallow clones
          _optionValues: { ...this._optionValues },
          _optionValueSources: { ...this._optionValueSources }
        };
      }
      /**
       * Restore state before parse for calls after the first.
       * Not usually called directly, but available for subclasses to save their custom state.
       *
       * This is called in a lazy way. Only commands used in parsing chain will have state restored.
       */
      restoreStateBeforeParse() {
        if (this._storeOptionsAsProperties)
          throw new Error(`Can not call parse again when storeOptionsAsProperties is true.
- either make a new Command for each call to parse, or stop storing options as properties`);
        this._name = this._savedState._name;
        this._scriptPath = null;
        this.rawArgs = [];
        this._optionValues = { ...this._savedState._optionValues };
        this._optionValueSources = { ...this._savedState._optionValueSources };
        this.args = [];
        this.processedArgs = [];
      }
      /**
       * Throw if expected executable is missing. Add lots of help for author.
       *
       * @param {string} executableFile
       * @param {string} executableDir
       * @param {string} subcommandName
       */
      _checkForMissingExecutable(executableFile, executableDir, subcommandName) {
        if (fs6.existsSync(executableFile)) return;
        const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
        const executableMissing = `'${executableFile}' does not exist
 - if '${subcommandName}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
        throw new Error(executableMissing);
      }
      /**
       * Execute a sub-command executable.
       *
       * @private
       */
      _executeSubCommand(subcommand, args) {
        args = args.slice();
        let launchWithNode = false;
        const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
        function findFile(baseDir, baseName) {
          const localBin = path8.resolve(baseDir, baseName);
          if (fs6.existsSync(localBin)) return localBin;
          if (sourceExt.includes(path8.extname(baseName))) return void 0;
          const foundExt = sourceExt.find(
            (ext) => fs6.existsSync(`${localBin}${ext}`)
          );
          if (foundExt) return `${localBin}${foundExt}`;
          return void 0;
        }
        this._checkForMissingMandatoryOptions();
        this._checkForConflictingOptions();
        let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
        let executableDir = this._executableDir || "";
        if (this._scriptPath) {
          let resolvedScriptPath;
          try {
            resolvedScriptPath = fs6.realpathSync(this._scriptPath);
          } catch {
            resolvedScriptPath = this._scriptPath;
          }
          executableDir = path8.resolve(
            path8.dirname(resolvedScriptPath),
            executableDir
          );
        }
        if (executableDir) {
          let localFile = findFile(executableDir, executableFile);
          if (!localFile && !subcommand._executableFile && this._scriptPath) {
            const legacyName = path8.basename(
              this._scriptPath,
              path8.extname(this._scriptPath)
            );
            if (legacyName !== this._name) {
              localFile = findFile(
                executableDir,
                `${legacyName}-${subcommand._name}`
              );
            }
          }
          executableFile = localFile || executableFile;
        }
        launchWithNode = sourceExt.includes(path8.extname(executableFile));
        let proc;
        if (process2.platform !== "win32") {
          if (launchWithNode) {
            args.unshift(executableFile);
            args = incrementNodeInspectorPort(process2.execArgv).concat(args);
            proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
          } else {
            proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
          }
        } else {
          this._checkForMissingExecutable(
            executableFile,
            executableDir,
            subcommand._name
          );
          args.unshift(executableFile);
          args = incrementNodeInspectorPort(process2.execArgv).concat(args);
          proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
        }
        if (!proc.killed) {
          const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
          signals.forEach((signal) => {
            process2.on(signal, () => {
              if (proc.killed === false && proc.exitCode === null) {
                proc.kill(signal);
              }
            });
          });
        }
        const exitCallback = this._exitCallback;
        proc.on("close", (code) => {
          code = code ?? 1;
          if (!exitCallback) {
            process2.exit(code);
          } else {
            exitCallback(
              new CommanderError2(
                code,
                "commander.executeSubCommandAsync",
                "(close)"
              )
            );
          }
        });
        proc.on("error", (err) => {
          if (err.code === "ENOENT") {
            this._checkForMissingExecutable(
              executableFile,
              executableDir,
              subcommand._name
            );
          } else if (err.code === "EACCES") {
            throw new Error(`'${executableFile}' not executable`);
          }
          if (!exitCallback) {
            process2.exit(1);
          } else {
            const wrappedError = new CommanderError2(
              1,
              "commander.executeSubCommandAsync",
              "(error)"
            );
            wrappedError.nestedError = err;
            exitCallback(wrappedError);
          }
        });
        this.runningCommand = proc;
      }
      /**
       * @private
       */
      _dispatchSubcommand(commandName, operands, unknown) {
        const subCommand = this._findCommand(commandName);
        if (!subCommand) this.help({ error: true });
        subCommand._prepareForParse();
        let promiseChain;
        promiseChain = this._chainOrCallSubCommandHook(
          promiseChain,
          subCommand,
          "preSubcommand"
        );
        promiseChain = this._chainOrCall(promiseChain, () => {
          if (subCommand._executableHandler) {
            this._executeSubCommand(subCommand, operands.concat(unknown));
          } else {
            return subCommand._parseCommand(operands, unknown);
          }
        });
        return promiseChain;
      }
      /**
       * Invoke help directly if possible, or dispatch if necessary.
       * e.g. help foo
       *
       * @private
       */
      _dispatchHelpCommand(subcommandName) {
        if (!subcommandName) {
          this.help();
        }
        const subCommand = this._findCommand(subcommandName);
        if (subCommand && !subCommand._executableHandler) {
          subCommand.help();
        }
        return this._dispatchSubcommand(
          subcommandName,
          [],
          [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]
        );
      }
      /**
       * Check this.args against expected this.registeredArguments.
       *
       * @private
       */
      _checkNumberOfArguments() {
        this.registeredArguments.forEach((arg, i) => {
          if (arg.required && this.args[i] == null) {
            this.missingArgument(arg.name());
          }
        });
        if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
          return;
        }
        if (this.args.length > this.registeredArguments.length) {
          this._excessArguments(this.args);
        }
      }
      /**
       * Process this.args using this.registeredArguments and save as this.processedArgs!
       *
       * @private
       */
      _processArguments() {
        const myParseArg = (argument, value, previous) => {
          let parsedValue = value;
          if (value !== null && argument.parseArg) {
            const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
            parsedValue = this._callParseArg(
              argument,
              value,
              previous,
              invalidValueMessage
            );
          }
          return parsedValue;
        };
        this._checkNumberOfArguments();
        const processedArgs = [];
        this.registeredArguments.forEach((declaredArg, index) => {
          let value = declaredArg.defaultValue;
          if (declaredArg.variadic) {
            if (index < this.args.length) {
              value = this.args.slice(index);
              if (declaredArg.parseArg) {
                value = value.reduce((processed, v) => {
                  return myParseArg(declaredArg, v, processed);
                }, declaredArg.defaultValue);
              }
            } else if (value === void 0) {
              value = [];
            }
          } else if (index < this.args.length) {
            value = this.args[index];
            if (declaredArg.parseArg) {
              value = myParseArg(declaredArg, value, declaredArg.defaultValue);
            }
          }
          processedArgs[index] = value;
        });
        this.processedArgs = processedArgs;
      }
      /**
       * Once we have a promise we chain, but call synchronously until then.
       *
       * @param {(Promise|undefined)} promise
       * @param {Function} fn
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCall(promise, fn) {
        if (promise?.then && typeof promise.then === "function") {
          return promise.then(() => fn());
        }
        return fn();
      }
      /**
       *
       * @param {(Promise|undefined)} promise
       * @param {string} event
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCallHooks(promise, event) {
        let result = promise;
        const hooks = [];
        this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== void 0).forEach((hookedCommand) => {
          hookedCommand._lifeCycleHooks[event].forEach((callback) => {
            hooks.push({ hookedCommand, callback });
          });
        });
        if (event === "postAction") {
          hooks.reverse();
        }
        hooks.forEach((hookDetail) => {
          result = this._chainOrCall(result, () => {
            return hookDetail.callback(hookDetail.hookedCommand, this);
          });
        });
        return result;
      }
      /**
       *
       * @param {(Promise|undefined)} promise
       * @param {Command} subCommand
       * @param {string} event
       * @return {(Promise|undefined)}
       * @private
       */
      _chainOrCallSubCommandHook(promise, subCommand, event) {
        let result = promise;
        if (this._lifeCycleHooks[event] !== void 0) {
          this._lifeCycleHooks[event].forEach((hook) => {
            result = this._chainOrCall(result, () => {
              return hook(this, subCommand);
            });
          });
        }
        return result;
      }
      /**
       * Process arguments in context of this command.
       * Returns action result, in case it is a promise.
       *
       * @private
       */
      _parseCommand(operands, unknown) {
        const parsed = this.parseOptions(unknown);
        this._parseOptionsEnv();
        this._parseOptionsImplied();
        operands = operands.concat(parsed.operands);
        unknown = parsed.unknown;
        this.args = operands.concat(unknown);
        if (operands && this._findCommand(operands[0])) {
          return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
        }
        if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
          return this._dispatchHelpCommand(operands[1]);
        }
        if (this._defaultCommandName) {
          this._outputHelpIfRequested(unknown);
          return this._dispatchSubcommand(
            this._defaultCommandName,
            operands,
            unknown
          );
        }
        if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
          this.help({ error: true });
        }
        this._outputHelpIfRequested(parsed.unknown);
        this._checkForMissingMandatoryOptions();
        this._checkForConflictingOptions();
        const checkForUnknownOptions = () => {
          if (parsed.unknown.length > 0) {
            this.unknownOption(parsed.unknown[0]);
          }
        };
        const commandEvent = `command:${this.name()}`;
        if (this._actionHandler) {
          checkForUnknownOptions();
          this._processArguments();
          let promiseChain;
          promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
          promiseChain = this._chainOrCall(
            promiseChain,
            () => this._actionHandler(this.processedArgs)
          );
          if (this.parent) {
            promiseChain = this._chainOrCall(promiseChain, () => {
              this.parent.emit(commandEvent, operands, unknown);
            });
          }
          promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
          return promiseChain;
        }
        if (this.parent?.listenerCount(commandEvent)) {
          checkForUnknownOptions();
          this._processArguments();
          this.parent.emit(commandEvent, operands, unknown);
        } else if (operands.length) {
          if (this._findCommand("*")) {
            return this._dispatchSubcommand("*", operands, unknown);
          }
          if (this.listenerCount("command:*")) {
            this.emit("command:*", operands, unknown);
          } else if (this.commands.length) {
            this.unknownCommand();
          } else {
            checkForUnknownOptions();
            this._processArguments();
          }
        } else if (this.commands.length) {
          checkForUnknownOptions();
          this.help({ error: true });
        } else {
          checkForUnknownOptions();
          this._processArguments();
        }
      }
      /**
       * Find matching command.
       *
       * @private
       * @return {Command | undefined}
       */
      _findCommand(name) {
        if (!name) return void 0;
        return this.commands.find(
          (cmd) => cmd._name === name || cmd._aliases.includes(name)
        );
      }
      /**
       * Return an option matching `arg` if any.
       *
       * @param {string} arg
       * @return {Option}
       * @package
       */
      _findOption(arg) {
        return this.options.find((option) => option.is(arg));
      }
      /**
       * Display an error message if a mandatory option does not have a value.
       * Called after checking for help flags in leaf subcommand.
       *
       * @private
       */
      _checkForMissingMandatoryOptions() {
        this._getCommandAndAncestors().forEach((cmd) => {
          cmd.options.forEach((anOption) => {
            if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === void 0) {
              cmd.missingMandatoryOptionValue(anOption);
            }
          });
        });
      }
      /**
       * Display an error message if conflicting options are used together in this.
       *
       * @private
       */
      _checkForConflictingLocalOptions() {
        const definedNonDefaultOptions = this.options.filter((option) => {
          const optionKey = option.attributeName();
          if (this.getOptionValue(optionKey) === void 0) {
            return false;
          }
          return this.getOptionValueSource(optionKey) !== "default";
        });
        const optionsWithConflicting = definedNonDefaultOptions.filter(
          (option) => option.conflictsWith.length > 0
        );
        optionsWithConflicting.forEach((option) => {
          const conflictingAndDefined = definedNonDefaultOptions.find(
            (defined) => option.conflictsWith.includes(defined.attributeName())
          );
          if (conflictingAndDefined) {
            this._conflictingOption(option, conflictingAndDefined);
          }
        });
      }
      /**
       * Display an error message if conflicting options are used together.
       * Called after checking for help flags in leaf subcommand.
       *
       * @private
       */
      _checkForConflictingOptions() {
        this._getCommandAndAncestors().forEach((cmd) => {
          cmd._checkForConflictingLocalOptions();
        });
      }
      /**
       * Parse options from `argv` removing known options,
       * and return argv split into operands and unknown arguments.
       *
       * Side effects: modifies command by storing options. Does not reset state if called again.
       *
       * Examples:
       *
       *     argv => operands, unknown
       *     --known kkk op => [op], []
       *     op --known kkk => [op], []
       *     sub --unknown uuu op => [sub], [--unknown uuu op]
       *     sub -- --unknown uuu op => [sub --unknown uuu op], []
       *
       * @param {string[]} args
       * @return {{operands: string[], unknown: string[]}}
       */
      parseOptions(args) {
        const operands = [];
        const unknown = [];
        let dest = operands;
        function maybeOption(arg) {
          return arg.length > 1 && arg[0] === "-";
        }
        const negativeNumberArg = (arg) => {
          if (!/^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/.test(arg)) return false;
          return !this._getCommandAndAncestors().some(
            (cmd) => cmd.options.map((opt) => opt.short).some((short) => /^-\d$/.test(short))
          );
        };
        let activeVariadicOption = null;
        let activeGroup = null;
        let i = 0;
        while (i < args.length || activeGroup) {
          const arg = activeGroup ?? args[i++];
          activeGroup = null;
          if (arg === "--") {
            if (dest === unknown) dest.push(arg);
            dest.push(...args.slice(i));
            break;
          }
          if (activeVariadicOption && (!maybeOption(arg) || negativeNumberArg(arg))) {
            this.emit(`option:${activeVariadicOption.name()}`, arg);
            continue;
          }
          activeVariadicOption = null;
          if (maybeOption(arg)) {
            const option = this._findOption(arg);
            if (option) {
              if (option.required) {
                const value = args[i++];
                if (value === void 0) this.optionMissingArgument(option);
                this.emit(`option:${option.name()}`, value);
              } else if (option.optional) {
                let value = null;
                if (i < args.length && (!maybeOption(args[i]) || negativeNumberArg(args[i]))) {
                  value = args[i++];
                }
                this.emit(`option:${option.name()}`, value);
              } else {
                this.emit(`option:${option.name()}`);
              }
              activeVariadicOption = option.variadic ? option : null;
              continue;
            }
          }
          if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
            const option = this._findOption(`-${arg[1]}`);
            if (option) {
              if (option.required || option.optional && this._combineFlagAndOptionalValue) {
                this.emit(`option:${option.name()}`, arg.slice(2));
              } else {
                this.emit(`option:${option.name()}`);
                activeGroup = `-${arg.slice(2)}`;
              }
              continue;
            }
          }
          if (/^--[^=]+=/.test(arg)) {
            const index = arg.indexOf("=");
            const option = this._findOption(arg.slice(0, index));
            if (option && (option.required || option.optional)) {
              this.emit(`option:${option.name()}`, arg.slice(index + 1));
              continue;
            }
          }
          if (dest === operands && maybeOption(arg) && !(this.commands.length === 0 && negativeNumberArg(arg))) {
            dest = unknown;
          }
          if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
            if (this._findCommand(arg)) {
              operands.push(arg);
              unknown.push(...args.slice(i));
              break;
            } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
              operands.push(arg, ...args.slice(i));
              break;
            } else if (this._defaultCommandName) {
              unknown.push(arg, ...args.slice(i));
              break;
            }
          }
          if (this._passThroughOptions) {
            dest.push(arg, ...args.slice(i));
            break;
          }
          dest.push(arg);
        }
        return { operands, unknown };
      }
      /**
       * Return an object containing local option values as key-value pairs.
       *
       * @return {object}
       */
      opts() {
        if (this._storeOptionsAsProperties) {
          const result = {};
          const len = this.options.length;
          for (let i = 0; i < len; i++) {
            const key = this.options[i].attributeName();
            result[key] = key === this._versionOptionName ? this._version : this[key];
          }
          return result;
        }
        return this._optionValues;
      }
      /**
       * Return an object containing merged local and global option values as key-value pairs.
       *
       * @return {object}
       */
      optsWithGlobals() {
        return this._getCommandAndAncestors().reduce(
          (combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()),
          {}
        );
      }
      /**
       * Display error message and exit (or call exitOverride).
       *
       * @param {string} message
       * @param {object} [errorOptions]
       * @param {string} [errorOptions.code] - an id string representing the error
       * @param {number} [errorOptions.exitCode] - used with process.exit
       */
      error(message, errorOptions) {
        this._outputConfiguration.outputError(
          `${message}
`,
          this._outputConfiguration.writeErr
        );
        if (typeof this._showHelpAfterError === "string") {
          this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
        } else if (this._showHelpAfterError) {
          this._outputConfiguration.writeErr("\n");
          this.outputHelp({ error: true });
        }
        const config = errorOptions || {};
        const exitCode = config.exitCode || 1;
        const code = config.code || "commander.error";
        this._exit(exitCode, code, message);
      }
      /**
       * Apply any option related environment variables, if option does
       * not have a value from cli or client code.
       *
       * @private
       */
      _parseOptionsEnv() {
        this.options.forEach((option) => {
          if (option.envVar && option.envVar in process2.env) {
            const optionKey = option.attributeName();
            if (this.getOptionValue(optionKey) === void 0 || ["default", "config", "env"].includes(
              this.getOptionValueSource(optionKey)
            )) {
              if (option.required || option.optional) {
                this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
              } else {
                this.emit(`optionEnv:${option.name()}`);
              }
            }
          }
        });
      }
      /**
       * Apply any implied option values, if option is undefined or default value.
       *
       * @private
       */
      _parseOptionsImplied() {
        const dualHelper = new DualOptions(this.options);
        const hasCustomOptionValue = (optionKey) => {
          return this.getOptionValue(optionKey) !== void 0 && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
        };
        this.options.filter(
          (option) => option.implied !== void 0 && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(
            this.getOptionValue(option.attributeName()),
            option
          )
        ).forEach((option) => {
          Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
            this.setOptionValueWithSource(
              impliedKey,
              option.implied[impliedKey],
              "implied"
            );
          });
        });
      }
      /**
       * Argument `name` is missing.
       *
       * @param {string} name
       * @private
       */
      missingArgument(name) {
        const message = `error: missing required argument '${name}'`;
        this.error(message, { code: "commander.missingArgument" });
      }
      /**
       * `Option` is missing an argument.
       *
       * @param {Option} option
       * @private
       */
      optionMissingArgument(option) {
        const message = `error: option '${option.flags}' argument missing`;
        this.error(message, { code: "commander.optionMissingArgument" });
      }
      /**
       * `Option` does not have a value, and is a mandatory option.
       *
       * @param {Option} option
       * @private
       */
      missingMandatoryOptionValue(option) {
        const message = `error: required option '${option.flags}' not specified`;
        this.error(message, { code: "commander.missingMandatoryOptionValue" });
      }
      /**
       * `Option` conflicts with another option.
       *
       * @param {Option} option
       * @param {Option} conflictingOption
       * @private
       */
      _conflictingOption(option, conflictingOption) {
        const findBestOptionFromValue = (option2) => {
          const optionKey = option2.attributeName();
          const optionValue = this.getOptionValue(optionKey);
          const negativeOption = this.options.find(
            (target) => target.negate && optionKey === target.attributeName()
          );
          const positiveOption = this.options.find(
            (target) => !target.negate && optionKey === target.attributeName()
          );
          if (negativeOption && (negativeOption.presetArg === void 0 && optionValue === false || negativeOption.presetArg !== void 0 && optionValue === negativeOption.presetArg)) {
            return negativeOption;
          }
          return positiveOption || option2;
        };
        const getErrorMessage = (option2) => {
          const bestOption = findBestOptionFromValue(option2);
          const optionKey = bestOption.attributeName();
          const source = this.getOptionValueSource(optionKey);
          if (source === "env") {
            return `environment variable '${bestOption.envVar}'`;
          }
          return `option '${bestOption.flags}'`;
        };
        const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
        this.error(message, { code: "commander.conflictingOption" });
      }
      /**
       * Unknown option `flag`.
       *
       * @param {string} flag
       * @private
       */
      unknownOption(flag) {
        if (this._allowUnknownOption) return;
        let suggestion = "";
        if (flag.startsWith("--") && this._showSuggestionAfterError) {
          let candidateFlags = [];
          let command = this;
          do {
            const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
            candidateFlags = candidateFlags.concat(moreFlags);
            command = command.parent;
          } while (command && !command._enablePositionalOptions);
          suggestion = suggestSimilar(flag, candidateFlags);
        }
        const message = `error: unknown option '${flag}'${suggestion}`;
        this.error(message, { code: "commander.unknownOption" });
      }
      /**
       * Excess arguments, more than expected.
       *
       * @param {string[]} receivedArgs
       * @private
       */
      _excessArguments(receivedArgs) {
        if (this._allowExcessArguments) return;
        const expected = this.registeredArguments.length;
        const s = expected === 1 ? "" : "s";
        const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
        const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${receivedArgs.length}.`;
        this.error(message, { code: "commander.excessArguments" });
      }
      /**
       * Unknown command.
       *
       * @private
       */
      unknownCommand() {
        const unknownName = this.args[0];
        let suggestion = "";
        if (this._showSuggestionAfterError) {
          const candidateNames = [];
          this.createHelp().visibleCommands(this).forEach((command) => {
            candidateNames.push(command.name());
            if (command.alias()) candidateNames.push(command.alias());
          });
          suggestion = suggestSimilar(unknownName, candidateNames);
        }
        const message = `error: unknown command '${unknownName}'${suggestion}`;
        this.error(message, { code: "commander.unknownCommand" });
      }
      /**
       * Get or set the program version.
       *
       * This method auto-registers the "-V, --version" option which will print the version number.
       *
       * You can optionally supply the flags and description to override the defaults.
       *
       * @param {string} [str]
       * @param {string} [flags]
       * @param {string} [description]
       * @return {(this | string | undefined)} `this` command for chaining, or version string if no arguments
       */
      version(str, flags, description) {
        if (str === void 0) return this._version;
        this._version = str;
        flags = flags || "-V, --version";
        description = description || "output the version number";
        const versionOption = this.createOption(flags, description);
        this._versionOptionName = versionOption.attributeName();
        this._registerOption(versionOption);
        this.on("option:" + versionOption.name(), () => {
          this._outputConfiguration.writeOut(`${str}
`);
          this._exit(0, "commander.version", str);
        });
        return this;
      }
      /**
       * Set the description.
       *
       * @param {string} [str]
       * @param {object} [argsDescription]
       * @return {(string|Command)}
       */
      description(str, argsDescription) {
        if (str === void 0 && argsDescription === void 0)
          return this._description;
        this._description = str;
        if (argsDescription) {
          this._argsDescription = argsDescription;
        }
        return this;
      }
      /**
       * Set the summary. Used when listed as subcommand of parent.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      summary(str) {
        if (str === void 0) return this._summary;
        this._summary = str;
        return this;
      }
      /**
       * Set an alias for the command.
       *
       * You may call more than once to add multiple aliases. Only the first alias is shown in the auto-generated help.
       *
       * @param {string} [alias]
       * @return {(string|Command)}
       */
      alias(alias) {
        if (alias === void 0) return this._aliases[0];
        let command = this;
        if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
          command = this.commands[this.commands.length - 1];
        }
        if (alias === command._name)
          throw new Error("Command alias can't be the same as its name");
        const matchingCommand = this.parent?._findCommand(alias);
        if (matchingCommand) {
          const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
          throw new Error(
            `cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`
          );
        }
        command._aliases.push(alias);
        return this;
      }
      /**
       * Set aliases for the command.
       *
       * Only the first alias is shown in the auto-generated help.
       *
       * @param {string[]} [aliases]
       * @return {(string[]|Command)}
       */
      aliases(aliases) {
        if (aliases === void 0) return this._aliases;
        aliases.forEach((alias) => this.alias(alias));
        return this;
      }
      /**
       * Set / get the command usage `str`.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      usage(str) {
        if (str === void 0) {
          if (this._usage) return this._usage;
          const args = this.registeredArguments.map((arg) => {
            return humanReadableArgName(arg);
          });
          return [].concat(
            this.options.length || this._helpOption !== null ? "[options]" : [],
            this.commands.length ? "[command]" : [],
            this.registeredArguments.length ? args : []
          ).join(" ");
        }
        this._usage = str;
        return this;
      }
      /**
       * Get or set the name of the command.
       *
       * @param {string} [str]
       * @return {(string|Command)}
       */
      name(str) {
        if (str === void 0) return this._name;
        this._name = str;
        return this;
      }
      /**
       * Set/get the help group heading for this subcommand in parent command's help.
       *
       * @param {string} [heading]
       * @return {Command | string}
       */
      helpGroup(heading) {
        if (heading === void 0) return this._helpGroupHeading ?? "";
        this._helpGroupHeading = heading;
        return this;
      }
      /**
       * Set/get the default help group heading for subcommands added to this command.
       * (This does not override a group set directly on the subcommand using .helpGroup().)
       *
       * @example
       * program.commandsGroup('Development Commands:);
       * program.command('watch')...
       * program.command('lint')...
       * ...
       *
       * @param {string} [heading]
       * @returns {Command | string}
       */
      commandsGroup(heading) {
        if (heading === void 0) return this._defaultCommandGroup ?? "";
        this._defaultCommandGroup = heading;
        return this;
      }
      /**
       * Set/get the default help group heading for options added to this command.
       * (This does not override a group set directly on the option using .helpGroup().)
       *
       * @example
       * program
       *   .optionsGroup('Development Options:')
       *   .option('-d, --debug', 'output extra debugging')
       *   .option('-p, --profile', 'output profiling information')
       *
       * @param {string} [heading]
       * @returns {Command | string}
       */
      optionsGroup(heading) {
        if (heading === void 0) return this._defaultOptionGroup ?? "";
        this._defaultOptionGroup = heading;
        return this;
      }
      /**
       * @param {Option} option
       * @private
       */
      _initOptionGroup(option) {
        if (this._defaultOptionGroup && !option.helpGroupHeading)
          option.helpGroup(this._defaultOptionGroup);
      }
      /**
       * @param {Command} cmd
       * @private
       */
      _initCommandGroup(cmd) {
        if (this._defaultCommandGroup && !cmd.helpGroup())
          cmd.helpGroup(this._defaultCommandGroup);
      }
      /**
       * Set the name of the command from script filename, such as process.argv[1],
       * or require.main.filename, or __filename.
       *
       * (Used internally and public although not documented in README.)
       *
       * @example
       * program.nameFromFilename(require.main.filename);
       *
       * @param {string} filename
       * @return {Command}
       */
      nameFromFilename(filename) {
        this._name = path8.basename(filename, path8.extname(filename));
        return this;
      }
      /**
       * Get or set the directory for searching for executable subcommands of this command.
       *
       * @example
       * program.executableDir(__dirname);
       * // or
       * program.executableDir('subcommands');
       *
       * @param {string} [path]
       * @return {(string|null|Command)}
       */
      executableDir(path9) {
        if (path9 === void 0) return this._executableDir;
        this._executableDir = path9;
        return this;
      }
      /**
       * Return program help documentation.
       *
       * @param {{ error: boolean }} [contextOptions] - pass {error:true} to wrap for stderr instead of stdout
       * @return {string}
       */
      helpInformation(contextOptions) {
        const helper = this.createHelp();
        const context = this._getOutputContext(contextOptions);
        helper.prepareContext({
          error: context.error,
          helpWidth: context.helpWidth,
          outputHasColors: context.hasColors
        });
        const text = helper.formatHelp(this, helper);
        if (context.hasColors) return text;
        return this._outputConfiguration.stripColor(text);
      }
      /**
       * @typedef HelpContext
       * @type {object}
       * @property {boolean} error
       * @property {number} helpWidth
       * @property {boolean} hasColors
       * @property {function} write - includes stripColor if needed
       *
       * @returns {HelpContext}
       * @private
       */
      _getOutputContext(contextOptions) {
        contextOptions = contextOptions || {};
        const error = !!contextOptions.error;
        let baseWrite;
        let hasColors;
        let helpWidth;
        if (error) {
          baseWrite = (str) => this._outputConfiguration.writeErr(str);
          hasColors = this._outputConfiguration.getErrHasColors();
          helpWidth = this._outputConfiguration.getErrHelpWidth();
        } else {
          baseWrite = (str) => this._outputConfiguration.writeOut(str);
          hasColors = this._outputConfiguration.getOutHasColors();
          helpWidth = this._outputConfiguration.getOutHelpWidth();
        }
        const write = (str) => {
          if (!hasColors) str = this._outputConfiguration.stripColor(str);
          return baseWrite(str);
        };
        return { error, write, hasColors, helpWidth };
      }
      /**
       * Output help information for this command.
       *
       * Outputs built-in help, and custom text added using `.addHelpText()`.
       *
       * @param {{ error: boolean } | Function} [contextOptions] - pass {error:true} to write to stderr instead of stdout
       */
      outputHelp(contextOptions) {
        let deprecatedCallback;
        if (typeof contextOptions === "function") {
          deprecatedCallback = contextOptions;
          contextOptions = void 0;
        }
        const outputContext = this._getOutputContext(contextOptions);
        const eventContext = {
          error: outputContext.error,
          write: outputContext.write,
          command: this
        };
        this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", eventContext));
        this.emit("beforeHelp", eventContext);
        let helpInformation = this.helpInformation({ error: outputContext.error });
        if (deprecatedCallback) {
          helpInformation = deprecatedCallback(helpInformation);
          if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
            throw new Error("outputHelp callback must return a string or a Buffer");
          }
        }
        outputContext.write(helpInformation);
        if (this._getHelpOption()?.long) {
          this.emit(this._getHelpOption().long);
        }
        this.emit("afterHelp", eventContext);
        this._getCommandAndAncestors().forEach(
          (command) => command.emit("afterAllHelp", eventContext)
        );
      }
      /**
       * You can pass in flags and a description to customise the built-in help option.
       * Pass in false to disable the built-in help option.
       *
       * @example
       * program.helpOption('-?, --help' 'show help'); // customise
       * program.helpOption(false); // disable
       *
       * @param {(string | boolean)} flags
       * @param {string} [description]
       * @return {Command} `this` command for chaining
       */
      helpOption(flags, description) {
        if (typeof flags === "boolean") {
          if (flags) {
            if (this._helpOption === null) this._helpOption = void 0;
            if (this._defaultOptionGroup) {
              this._initOptionGroup(this._getHelpOption());
            }
          } else {
            this._helpOption = null;
          }
          return this;
        }
        this._helpOption = this.createOption(
          flags ?? "-h, --help",
          description ?? "display help for command"
        );
        if (flags || description) this._initOptionGroup(this._helpOption);
        return this;
      }
      /**
       * Lazy create help option.
       * Returns null if has been disabled with .helpOption(false).
       *
       * @returns {(Option | null)} the help option
       * @package
       */
      _getHelpOption() {
        if (this._helpOption === void 0) {
          this.helpOption(void 0, void 0);
        }
        return this._helpOption;
      }
      /**
       * Supply your own option to use for the built-in help option.
       * This is an alternative to using helpOption() to customise the flags and description etc.
       *
       * @param {Option} option
       * @return {Command} `this` command for chaining
       */
      addHelpOption(option) {
        this._helpOption = option;
        this._initOptionGroup(option);
        return this;
      }
      /**
       * Output help information and exit.
       *
       * Outputs built-in help, and custom text added using `.addHelpText()`.
       *
       * @param {{ error: boolean }} [contextOptions] - pass {error:true} to write to stderr instead of stdout
       */
      help(contextOptions) {
        this.outputHelp(contextOptions);
        let exitCode = Number(process2.exitCode ?? 0);
        if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
          exitCode = 1;
        }
        this._exit(exitCode, "commander.help", "(outputHelp)");
      }
      /**
       * // Do a little typing to coordinate emit and listener for the help text events.
       * @typedef HelpTextEventContext
       * @type {object}
       * @property {boolean} error
       * @property {Command} command
       * @property {function} write
       */
      /**
       * Add additional text to be displayed with the built-in help.
       *
       * Position is 'before' or 'after' to affect just this command,
       * and 'beforeAll' or 'afterAll' to affect this command and all its subcommands.
       *
       * @param {string} position - before or after built-in help
       * @param {(string | Function)} text - string to add, or a function returning a string
       * @return {Command} `this` command for chaining
       */
      addHelpText(position, text) {
        const allowedValues = ["beforeAll", "before", "after", "afterAll"];
        if (!allowedValues.includes(position)) {
          throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
        }
        const helpEvent = `${position}Help`;
        this.on(helpEvent, (context) => {
          let helpStr;
          if (typeof text === "function") {
            helpStr = text({ error: context.error, command: context.command });
          } else {
            helpStr = text;
          }
          if (helpStr) {
            context.write(`${helpStr}
`);
          }
        });
        return this;
      }
      /**
       * Output help information if help flags specified
       *
       * @param {Array} args - array of options to search for help flags
       * @private
       */
      _outputHelpIfRequested(args) {
        const helpOption = this._getHelpOption();
        const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
        if (helpRequested) {
          this.outputHelp();
          this._exit(0, "commander.helpDisplayed", "(outputHelp)");
        }
      }
    };
    function incrementNodeInspectorPort(args) {
      return args.map((arg) => {
        if (!arg.startsWith("--inspect")) {
          return arg;
        }
        let debugOption;
        let debugHost = "127.0.0.1";
        let debugPort = "9229";
        let match;
        if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
          debugOption = match[1];
        } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
          debugOption = match[1];
          if (/^\d+$/.test(match[3])) {
            debugPort = match[3];
          } else {
            debugHost = match[3];
          }
        } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
          debugOption = match[1];
          debugHost = match[3];
          debugPort = match[4];
        }
        if (debugOption && debugPort !== "0") {
          return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
        }
        return arg;
      });
    }
    function useColor() {
      if (process2.env.NO_COLOR || process2.env.FORCE_COLOR === "0" || process2.env.FORCE_COLOR === "false")
        return false;
      if (process2.env.FORCE_COLOR || process2.env.CLICOLOR_FORCE !== void 0)
        return true;
      return void 0;
    }
    exports2.Command = Command2;
    exports2.useColor = useColor;
  }
});

// node_modules/commander/index.js
var require_commander = __commonJS({
  "node_modules/commander/index.js"(exports2) {
    var { Argument: Argument2 } = require_argument();
    var { Command: Command2 } = require_command();
    var { CommanderError: CommanderError2, InvalidArgumentError: InvalidArgumentError2 } = require_error();
    var { Help: Help2 } = require_help();
    var { Option: Option2 } = require_option();
    exports2.program = new Command2();
    exports2.createCommand = (name) => new Command2(name);
    exports2.createOption = (flags, description) => new Option2(flags, description);
    exports2.createArgument = (name, description) => new Argument2(name, description);
    exports2.Command = Command2;
    exports2.Option = Option2;
    exports2.Argument = Argument2;
    exports2.Help = Help2;
    exports2.CommanderError = CommanderError2;
    exports2.InvalidArgumentError = InvalidArgumentError2;
    exports2.InvalidOptionArgumentError = InvalidArgumentError2;
  }
});

// node_modules/dotenv/lib/main.js
var require_main = __commonJS({
  "node_modules/dotenv/lib/main.js"(exports2, module2) {
    var fs6 = require("fs");
    var path8 = require("path");
    var os3 = require("os");
    var crypto = require("crypto");
    var TIPS = [
      "\u25C8 encrypted .env [www.dotenvx.com]",
      "\u25C8 secrets for agents [www.dotenvx.com]",
      "\u2301 auth for agents [www.vestauth.com]",
      "\u2318 custom filepath { path: '/custom/path/.env' }",
      "\u2318 enable debugging { debug: true }",
      "\u2318 override existing { override: true }",
      "\u2318 suppress logs { quiet: true }",
      "\u2318 multiple files { path: ['.env.local', '.env'] }"
    ];
    function _getRandomTip() {
      return TIPS[Math.floor(Math.random() * TIPS.length)];
    }
    function parseBoolean(value) {
      if (typeof value === "string") {
        return !["false", "0", "no", "off", ""].includes(value.toLowerCase());
      }
      return Boolean(value);
    }
    function supportsAnsi() {
      return process.stdout.isTTY;
    }
    function dim(text) {
      return supportsAnsi() ? `\x1B[2m${text}\x1B[0m` : text;
    }
    var LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
    function parse(src) {
      const obj = {};
      let lines = src.toString();
      lines = lines.replace(/\r\n?/mg, "\n");
      let match;
      while ((match = LINE.exec(lines)) != null) {
        const key = match[1];
        let value = match[2] || "";
        value = value.trim();
        const maybeQuote = value[0];
        value = value.replace(/^(['"`])([\s\S]*)\1$/mg, "$2");
        if (maybeQuote === '"') {
          value = value.replace(/\\n/g, "\n");
          value = value.replace(/\\r/g, "\r");
        }
        obj[key] = value;
      }
      return obj;
    }
    function _parseVault(options) {
      options = options || {};
      const vaultPath = _vaultPath(options);
      options.path = vaultPath;
      const result = DotenvModule.configDotenv(options);
      if (!result.parsed) {
        const err = new Error(`MISSING_DATA: Cannot parse ${vaultPath} for an unknown reason`);
        err.code = "MISSING_DATA";
        throw err;
      }
      const keys = _dotenvKey(options).split(",");
      const length = keys.length;
      let decrypted;
      for (let i = 0; i < length; i++) {
        try {
          const key = keys[i].trim();
          const attrs = _instructions(result, key);
          decrypted = DotenvModule.decrypt(attrs.ciphertext, attrs.key);
          break;
        } catch (error) {
          if (i + 1 >= length) {
            throw error;
          }
        }
      }
      return DotenvModule.parse(decrypted);
    }
    function _warn(message) {
      console.error(`\u26A0 ${message}`);
    }
    function _debug(message) {
      console.log(`\u2506 ${message}`);
    }
    function _log(message) {
      console.log(`\u25C7 ${message}`);
    }
    function _dotenvKey(options) {
      if (options && options.DOTENV_KEY && options.DOTENV_KEY.length > 0) {
        return options.DOTENV_KEY;
      }
      if (process.env.DOTENV_KEY && process.env.DOTENV_KEY.length > 0) {
        return process.env.DOTENV_KEY;
      }
      return "";
    }
    function _instructions(result, dotenvKey) {
      let uri;
      try {
        uri = new URL(dotenvKey);
      } catch (error) {
        if (error.code === "ERR_INVALID_URL") {
          const err = new Error("INVALID_DOTENV_KEY: Wrong format. Must be in valid uri format like dotenv://:key_1234@dotenvx.com/vault/.env.vault?environment=development");
          err.code = "INVALID_DOTENV_KEY";
          throw err;
        }
        throw error;
      }
      const key = uri.password;
      if (!key) {
        const err = new Error("INVALID_DOTENV_KEY: Missing key part");
        err.code = "INVALID_DOTENV_KEY";
        throw err;
      }
      const environment = uri.searchParams.get("environment");
      if (!environment) {
        const err = new Error("INVALID_DOTENV_KEY: Missing environment part");
        err.code = "INVALID_DOTENV_KEY";
        throw err;
      }
      const environmentKey = `DOTENV_VAULT_${environment.toUpperCase()}`;
      const ciphertext = result.parsed[environmentKey];
      if (!ciphertext) {
        const err = new Error(`NOT_FOUND_DOTENV_ENVIRONMENT: Cannot locate environment ${environmentKey} in your .env.vault file.`);
        err.code = "NOT_FOUND_DOTENV_ENVIRONMENT";
        throw err;
      }
      return { ciphertext, key };
    }
    function _vaultPath(options) {
      let possibleVaultPath = null;
      if (options && options.path && options.path.length > 0) {
        if (Array.isArray(options.path)) {
          for (const filepath of options.path) {
            if (fs6.existsSync(filepath)) {
              possibleVaultPath = filepath.endsWith(".vault") ? filepath : `${filepath}.vault`;
            }
          }
        } else {
          possibleVaultPath = options.path.endsWith(".vault") ? options.path : `${options.path}.vault`;
        }
      } else {
        possibleVaultPath = path8.resolve(process.cwd(), ".env.vault");
      }
      if (fs6.existsSync(possibleVaultPath)) {
        return possibleVaultPath;
      }
      return null;
    }
    function _resolveHome(envPath) {
      return envPath[0] === "~" ? path8.join(os3.homedir(), envPath.slice(1)) : envPath;
    }
    function _configVault(options) {
      const debug = parseBoolean(process.env.DOTENV_CONFIG_DEBUG || options && options.debug);
      const quiet = parseBoolean(process.env.DOTENV_CONFIG_QUIET || options && options.quiet);
      if (debug || !quiet) {
        _log("loading env from encrypted .env.vault");
      }
      const parsed = DotenvModule._parseVault(options);
      let processEnv = process.env;
      if (options && options.processEnv != null) {
        processEnv = options.processEnv;
      }
      DotenvModule.populate(processEnv, parsed, options);
      return { parsed };
    }
    function configDotenv(options) {
      const dotenvPath = path8.resolve(process.cwd(), ".env");
      let encoding = "utf8";
      let processEnv = process.env;
      if (options && options.processEnv != null) {
        processEnv = options.processEnv;
      }
      let debug = parseBoolean(processEnv.DOTENV_CONFIG_DEBUG || options && options.debug);
      let quiet = parseBoolean(processEnv.DOTENV_CONFIG_QUIET || options && options.quiet);
      if (options && options.encoding) {
        encoding = options.encoding;
      } else {
        if (debug) {
          _debug("no encoding is specified (UTF-8 is used by default)");
        }
      }
      let optionPaths = [dotenvPath];
      if (options && options.path) {
        if (!Array.isArray(options.path)) {
          optionPaths = [_resolveHome(options.path)];
        } else {
          optionPaths = [];
          for (const filepath of options.path) {
            optionPaths.push(_resolveHome(filepath));
          }
        }
      }
      let lastError;
      const parsedAll = {};
      for (const path9 of optionPaths) {
        try {
          const parsed = DotenvModule.parse(fs6.readFileSync(path9, { encoding }));
          DotenvModule.populate(parsedAll, parsed, options);
        } catch (e) {
          if (debug) {
            _debug(`failed to load ${path9} ${e.message}`);
          }
          lastError = e;
        }
      }
      const populated = DotenvModule.populate(processEnv, parsedAll, options);
      debug = parseBoolean(processEnv.DOTENV_CONFIG_DEBUG || debug);
      quiet = parseBoolean(processEnv.DOTENV_CONFIG_QUIET || quiet);
      if (debug || !quiet) {
        const keysCount = Object.keys(populated).length;
        const shortPaths = [];
        for (const filePath of optionPaths) {
          try {
            const relative = path8.relative(process.cwd(), filePath);
            shortPaths.push(relative);
          } catch (e) {
            if (debug) {
              _debug(`failed to load ${filePath} ${e.message}`);
            }
            lastError = e;
          }
        }
        _log(`injected env (${keysCount}) from ${shortPaths.join(",")} ${dim(`// tip: ${_getRandomTip()}`)}`);
      }
      if (lastError) {
        return { parsed: parsedAll, error: lastError };
      } else {
        return { parsed: parsedAll };
      }
    }
    function config(options) {
      if (_dotenvKey(options).length === 0) {
        return DotenvModule.configDotenv(options);
      }
      const vaultPath = _vaultPath(options);
      if (!vaultPath) {
        _warn(`you set DOTENV_KEY but you are missing a .env.vault file at ${vaultPath}`);
        return DotenvModule.configDotenv(options);
      }
      return DotenvModule._configVault(options);
    }
    function decrypt(encrypted, keyStr) {
      const key = Buffer.from(keyStr.slice(-64), "hex");
      let ciphertext = Buffer.from(encrypted, "base64");
      const nonce = ciphertext.subarray(0, 12);
      const authTag = ciphertext.subarray(-16);
      ciphertext = ciphertext.subarray(12, -16);
      try {
        const aesgcm = crypto.createDecipheriv("aes-256-gcm", key, nonce);
        aesgcm.setAuthTag(authTag);
        return `${aesgcm.update(ciphertext)}${aesgcm.final()}`;
      } catch (error) {
        const isRange = error instanceof RangeError;
        const invalidKeyLength = error.message === "Invalid key length";
        const decryptionFailed = error.message === "Unsupported state or unable to authenticate data";
        if (isRange || invalidKeyLength) {
          const err = new Error("INVALID_DOTENV_KEY: It must be 64 characters long (or more)");
          err.code = "INVALID_DOTENV_KEY";
          throw err;
        } else if (decryptionFailed) {
          const err = new Error("DECRYPTION_FAILED: Please check your DOTENV_KEY");
          err.code = "DECRYPTION_FAILED";
          throw err;
        } else {
          throw error;
        }
      }
    }
    function populate(processEnv, parsed, options = {}) {
      const debug = Boolean(options && options.debug);
      const override = Boolean(options && options.override);
      const populated = {};
      if (typeof parsed !== "object") {
        const err = new Error("OBJECT_REQUIRED: Please check the processEnv argument being passed to populate");
        err.code = "OBJECT_REQUIRED";
        throw err;
      }
      for (const key of Object.keys(parsed)) {
        if (Object.prototype.hasOwnProperty.call(processEnv, key)) {
          if (override === true) {
            processEnv[key] = parsed[key];
            populated[key] = parsed[key];
          }
          if (debug) {
            if (override === true) {
              _debug(`"${key}" is already defined and WAS overwritten`);
            } else {
              _debug(`"${key}" is already defined and was NOT overwritten`);
            }
          }
        } else {
          processEnv[key] = parsed[key];
          populated[key] = parsed[key];
        }
      }
      return populated;
    }
    var DotenvModule = {
      configDotenv,
      _configVault,
      _parseVault,
      config,
      decrypt,
      parse,
      populate
    };
    module2.exports.configDotenv = DotenvModule.configDotenv;
    module2.exports._configVault = DotenvModule._configVault;
    module2.exports._parseVault = DotenvModule._parseVault;
    module2.exports.config = DotenvModule.config;
    module2.exports.decrypt = DotenvModule.decrypt;
    module2.exports.parse = DotenvModule.parse;
    module2.exports.populate = DotenvModule.populate;
    module2.exports = DotenvModule;
  }
});

// node_modules/commander/esm.mjs
var import_index = __toESM(require_commander(), 1);
var {
  program,
  createCommand,
  createArgument,
  createOption,
  CommanderError,
  InvalidArgumentError,
  InvalidOptionArgumentError,
  // deprecated old name
  Command,
  Argument,
  Option,
  Help
} = import_index.default;

// src/config/config.ts
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);

// src/api/errors.ts
var AppError = class extends Error {
  code;
  userMessage;
  details;
  constructor(params) {
    super(`${params.code}: ${params.userMessage}`, { cause: params.cause });
    this.name = "AppError";
    this.code = params.code;
    this.userMessage = params.userMessage;
    this.details = params.details;
  }
};

// src/config/config.ts
var T_INVEST_MODES = ["sandbox", "readonly", "full"];
var TOKEN_ENV_VARS = {
  sandbox: "T_INVEST_TOKEN_SANDBOX",
  readonly: "T_INVEST_TOKEN_READONLY",
  full: "T_INVEST_TOKEN_FULL"
};
var TRADING_ENABLE_ENV_VAR = "T_INVEST_ALLOW_TRADING";
var STONKS_MODE_ENV_VAR = "T_INVEST_STONKS_MODE";
var TRUTHY_FLAG_VALUES = ["true", "1", "yes", "on"];
var T_INVEST_BASE_URL = "https://invest-public-api.tinkoff.ru/rest";
var T_INVEST_SANDBOX_BASE_URL = "https://sandbox-invest-public-api.tinkoff.ru/rest";
var REQUEST_TIMEOUT_MS = 3e4;
var APP_VERSION = "1.1.0";
var MS_PER_HOUR = 60 * 60 * 1e3;
var MS_PER_DAY = 24 * MS_PER_HOUR;
var MS_PER_YEAR = 365 * MS_PER_DAY;
var SCHEDULE_DEFAULT_DAYS = 7;
var LAST_TRADES_DEFAULT_HOURS = 1;
var DEFAULT_OPERATIONS_DAYS = 30;
var OPERATIONS_PAGE_LIMIT = 1e3;
var MAX_OPERATIONS_PAGES = 100;
var DEFAULT_SANDBOX_PAYIN_RUB = 1e6;
var MAX_SANDBOX_PAYIN_RUB = 3e7;
var GLOBAL_ENV_PATH = import_node_path.default.join(import_node_os.default.homedir(), ".config", "tinvest", ".env");
var TRADES_LOG_PATH = import_node_path.default.join(import_node_os.default.homedir(), ".config", "tinvest", "trades.log");
var MARKET_ORDER_MAX_SPREAD_PERCENT = 1;
var CATALOG_CACHE_DIR = import_node_path.default.join(import_node_os.default.homedir(), ".config", "tinvest", "cache");
var CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
var BATCH_CONCURRENCY = 4;
var BATCH_MIN_INTERVAL_MS = 250;
var CONCENTRATION_WARN_PERCENT = 20;
var INCOME_HORIZON_DAYS = 365;
var EXTREME_XIRR_WARN_PERCENT = 100;
var DEFAULT_HISTORY_DAYS = 365;
var CANDLES_HOUR_MAX_DAYS = 3;
var CANDLES_DAY_MAX_DAYS = 366;
var CANDLES_WEEK_MAX_DAYS = 730;
var CANDLES_MONTH_MAX_DAYS = 3650;
var TRADING_DAYS_PER_YEAR = 252;
var WEEKS_PER_YEAR = 52;
var MONTHS_PER_YEAR = 12;
var ORDERBOOK_DEPTH_DEFAULT = 10;
var ORDERBOOK_DEPTH_MAX = 50;
var SCREEN_TOP_DEFAULT = 15;
var SCREEN_BONDS_MAX_CANDIDATES = 150;
var COUPON_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var LAST_PRICES_CHUNK = 300;
var FUNDAMENTALS_CHUNK = 100;
var NEWS_DEFAULT_LIMIT = 15;
var NEWS_PAGE_LIMIT = 100;
var NEWS_FILTER_MAX_PAGES = 5;
var INSIDERS_DEFAULT_LIMIT = 20;
var SIGNALS_DEFAULT_LIMIT = 30;
var REPORTS_WINDOW_DAYS = 183;
var TECH_LOOKBACK_DAYS = 180;
var RSI_LENGTH = 14;
var RSI_OVERBOUGHT = 70;
var RSI_OVERSOLD = 30;
var SMA_FAST_LENGTH = 20;
var SMA_SLOW_LENGTH = 50;
var MACD_FAST = 12;
var MACD_SLOW = 26;
var MACD_SIGNAL = 9;
function parseMode(raw) {
  if (T_INVEST_MODES.includes(raw)) {
    return raw;
  }
  throw new AppError({
    code: "APP_CLI_INVALID_ARGUMENT",
    userMessage: `\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \xAB${raw}\xBB. \u0414\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u044B\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u044F --mode: sandbox, readonly, full.`
  });
}
function baseUrlForMode(mode) {
  return mode === "sandbox" ? T_INVEST_SANDBOX_BASE_URL : T_INVEST_BASE_URL;
}
function tokenAvailability(env) {
  return Object.fromEntries(
    T_INVEST_MODES.map((mode) => [mode, Boolean(env[TOKEN_ENV_VARS[mode]]?.trim())])
  );
}
function resolveModeAndToken(env, explicitMode) {
  if (explicitMode) {
    const envVar = TOKEN_ENV_VARS[explicitMode];
    const token = env[envVar]?.trim();
    if (!token) {
      throw new AppError({
        code: "APP_TINVEST_TOKEN_MISSING",
        userMessage: `\u0414\u043B\u044F \u0440\u0435\u0436\u0438\u043C\u0430 \xAB${explicitMode}\xBB \u043D\u0435 \u0437\u0430\u0434\u0430\u043D \u0442\u043E\u043A\u0435\u043D: \u0437\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 ${envVar} \u0432 \u0444\u0430\u0439\u043B\u0435 .env \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u0438\u043B\u0438 \u0432 ${GLOBAL_ENV_PATH}. \u0412\u044B\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0442\u043E\u043A\u0435\u043D \u043C\u043E\u0436\u043D\u043E \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439 (\u0440\u0430\u0437\u0434\u0435\u043B \xAB\u0422\u043E\u043A\u0435\u043D\u044B T-Invest API\xBB).`
      });
    }
    return { mode: explicitMode, token };
  }
  const available = T_INVEST_MODES.filter((mode) => Boolean(env[TOKEN_ENV_VARS[mode]]?.trim()));
  const single = available[0];
  if (available.length === 1 && single) {
    return { mode: single, token: env[TOKEN_ENV_VARS[single]].trim() };
  }
  if (available.length === 0) {
    throw new AppError({
      code: "APP_TINVEST_TOKEN_MISSING",
      userMessage: `\u041D\u0435 \u0437\u0430\u0434\u0430\u043D \u043D\u0438 \u043E\u0434\u0438\u043D \u0442\u043E\u043A\u0435\u043D T-Invest API. \u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u0445\u043E\u0442\u044F \u0431\u044B \u043E\u0434\u043D\u0443 \u0438\u0437 \u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0445 ${Object.values(TOKEN_ENV_VARS).join(" / ")} \u0432 \u0444\u0430\u0439\u043B\u0435 .env \u043F\u0440\u043E\u0435\u043A\u0442\u0430 \u0438\u043B\u0438 \u0432 ${GLOBAL_ENV_PATH}. \u0422\u043E\u043A\u0435\u043D\u044B \u0432\u044B\u043F\u0443\u0441\u043A\u0430\u044E\u0442\u0441\u044F \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439 (\u0440\u0430\u0437\u0434\u0435\u043B \xAB\u0422\u043E\u043A\u0435\u043D\u044B T-Invest API\xBB).`
    });
  }
  throw new AppError({
    code: "APP_TINVEST_MODE_AMBIGUOUS",
    userMessage: `\u041D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043E \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0442\u043E\u043A\u0435\u043D\u043E\u0432 (\u0440\u0435\u0436\u0438\u043C\u044B: ${available.join(", ")}). \u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0440\u0435\u0436\u0438\u043C \u044F\u0432\u043D\u043E: --mode sandbox | readonly | full.`
  });
}
function parseBooleanFlag(raw) {
  return TRUTHY_FLAG_VALUES.includes((raw ?? "").trim().toLowerCase());
}
function resolveTradingGate(env) {
  const stonksMode = parseBooleanFlag(env[STONKS_MODE_ENV_VAR]);
  const allowTrading = stonksMode || parseBooleanFlag(env[TRADING_ENABLE_ENV_VAR]);
  return { allowTrading, stonksMode };
}

// src/api/money.ts
var NANO_PER_UNIT = 1e9;
var CURRENCY_SYMBOLS = {
  rub: "\u20BD",
  usd: "$",
  eur: "\u20AC",
  cny: "\xA5",
  gbp: "\xA3"
};
function quotationToNumber(q) {
  return Number(q.units) + q.nano / NANO_PER_UNIT;
}
function quotationToNumberOrNull(q) {
  return q === void 0 ? null : quotationToNumber(q);
}
function moneyToNumberOrNull(m) {
  return m === void 0 ? null : quotationToNumber(m);
}
function numberToQuotation(value) {
  let units = Math.trunc(value);
  let nano = Math.round((value - units) * NANO_PER_UNIT);
  if (nano >= NANO_PER_UNIT) {
    units += 1;
    nano -= NANO_PER_UNIT;
  } else if (nano <= -NANO_PER_UNIT) {
    units -= 1;
    nano += NANO_PER_UNIT;
  }
  return { units: String(units), nano };
}
function moneyToNumber(m) {
  return quotationToNumber(m);
}
function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor + 0;
}
function formatAmount(value, fractionDigits = 2) {
  const fixed = value.toFixed(fractionDigits);
  const negative = fixed.startsWith("-");
  const [intPart = "", fracPart] = (negative ? fixed.slice(1) : fixed).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const sign = negative ? "-" : "";
  return fracPart ? `${sign}${grouped}.${fracPart}` : `${sign}${grouped}`;
}
function formatSigned(value, fractionDigits = 2) {
  return value >= 0 ? `+${formatAmount(value, fractionDigits)}` : formatAmount(value, fractionDigits);
}
function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code.toLowerCase()] ?? code.toUpperCase();
}
function formatMoney(m) {
  return `${formatAmount(moneyToNumber(m))} ${currencySymbol(m.currency)}`;
}

// src/catalog/instrument-catalog.ts
var import_node_path3 = __toESM(require("node:path"), 1);

// src/catalog/file-cache.ts
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
function readVersionedCache(filePath, schemaVersion, label) {
  if (!import_node_fs.default.existsSync(filePath)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(import_node_fs.default.readFileSync(filePath, "utf8"));
  } catch {
    console.error(`\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435: \u043A\u044D\u0448 ${label} \u043F\u043E\u0432\u0440\u0435\u0436\u0434\u0451\u043D \u0438 \u0431\u0443\u0434\u0435\u0442 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0438\u0441\u0430\u043D: ${filePath}`);
    return null;
  }
  const envelope = parsed;
  if (!envelope || typeof envelope !== "object" || envelope.schemaVersion !== schemaVersion) {
    return null;
  }
  return envelope.body;
}
function writeVersionedCache(filePath, schemaVersion, body) {
  import_node_fs.default.mkdirSync(import_node_path2.default.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  import_node_fs.default.writeFileSync(tmpPath, JSON.stringify({ schemaVersion, body }));
  import_node_fs.default.renameSync(tmpPath, filePath);
}

// src/catalog/instrument-catalog.ts
var CATALOG_CACHE_SCHEMA_VERSION = 1;
function contourForMode(mode) {
  return mode === "sandbox" ? "sandbox" : "prod";
}
function catalogCachePath(cacheDir, contour, kind) {
  return import_node_path3.default.join(cacheDir, `catalog-${contour}-${kind}.json`);
}
function readFreshCache(filePath, now) {
  const cache = readVersionedCache(
    filePath,
    CATALOG_CACHE_SCHEMA_VERSION,
    "\u0441\u043F\u0440\u0430\u0432\u043E\u0447\u043D\u0438\u043A\u0430"
  );
  if (!cache) {
    return null;
  }
  if (typeof cache.savedAt !== "string" || !Array.isArray(cache.items)) {
    console.error(`\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435: \u0444\u0430\u0439\u043B \u043A\u044D\u0448\u0430 \u0441\u043F\u0440\u0430\u0432\u043E\u0447\u043D\u0438\u043A\u0430 \u0438\u043C\u0435\u0435\u0442 \u043D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u0444\u043E\u0440\u043C\u0430\u0442 \u0438 \u0431\u0443\u0434\u0435\u0442 \u043F\u0435\u0440\u0435\u0437\u0430\u043F\u0438\u0441\u0430\u043D: ${filePath}`);
    return null;
  }
  const age = now.getTime() - Date.parse(cache.savedAt);
  if (!(age >= 0) || age > CATALOG_CACHE_TTL_MS) {
    return null;
  }
  return cache;
}
function writeCache(filePath, cache) {
  writeVersionedCache(filePath, CATALOG_CACHE_SCHEMA_VERSION, cache);
}
async function fetchCatalog(api, kind) {
  if (kind === "bonds") {
    return (await api.getBonds()).instruments;
  }
  if (kind === "shares") {
    return (await api.getShares()).instruments;
  }
  return (await api.getEtfs()).instruments;
}
async function loadCatalog(api, kind, mode, now, cacheDir = CATALOG_CACHE_DIR) {
  const filePath = catalogCachePath(cacheDir, contourForMode(mode), kind);
  const cached = readFreshCache(filePath, now);
  if (cached) {
    return { items: cached.items, fromCache: true, savedAt: cached.savedAt };
  }
  const items = await fetchCatalog(api, kind);
  const savedAt = now.toISOString();
  writeCache(filePath, { savedAt, items });
  return { items, fromCache: false, savedAt };
}

// src/format/table.ts
function truncate(text, maxWidth) {
  return text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}\u2026` : text;
}
function renderTable(headers, rows) {
  const widths = headers.map(
    (header, col) => Math.max(header.length, ...rows.map((row) => (row[col] ?? "").length))
  );
  const renderRow = (cells) => widths.map((width, col) => (cells[col] ?? "").padEnd(width)).join("  ");
  const lines = [renderRow(headers), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const row of rows) {
    lines.push(renderRow(row));
  }
  return lines.join("\n");
}

// src/format/charts.ts
var BRAILLE_BASE = 10240;
var DOT_MATRIX = [
  [1, 8],
  [2, 16],
  [4, 32],
  [64, 128]
];
var DOTS_PER_CELL_X = 2;
var DOTS_PER_CELL_Y = 4;
var DEFAULT_LINE_WIDTH = 52;
var DEFAULT_LINE_HEIGHT = 8;
var DEFAULT_BAR_WIDTH = 28;
var MAX_BAR_LABEL_WIDTH = 14;
var DEFAULT_LINE_FRACTION_DIGITS = 2;
var AXIS = "\u2502";
var BAR_FULL = "\u2588";
var MSG_LINE_NO_DATA = "\u0413\u0440\u0430\u0444\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: \u043D\u0435\u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u0442\u043E\u0447\u0435\u043A \u0434\u0430\u043D\u043D\u044B\u0445.";
var MSG_BARS_NO_DATA = "\u0413\u0440\u0430\u0444\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: \u043D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445.";
function brailleLineChart(values, options = {}) {
  const width = options.width ?? DEFAULT_LINE_WIDTH;
  const height = options.height ?? DEFAULT_LINE_HEIGHT;
  const formatValue = options.formatValue ?? ((value) => value.toFixed(DEFAULT_LINE_FRACTION_DIGITS));
  const points = values.filter((value) => Number.isFinite(value));
  if (points.length < 2) {
    return MSG_LINE_NO_DATA;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  const cols = width * DOTS_PER_CELL_X;
  const rows = height * DOTS_PER_CELL_Y;
  const dotYs = [];
  for (let x = 0; x < cols; x += 1) {
    const position = x / (cols - 1) * (points.length - 1);
    const i0 = Math.floor(position);
    const i1 = Math.min(i0 + 1, points.length - 1);
    const value = points[i0] + (points[i1] - points[i0]) * (position - i0);
    dotYs.push(span === 0 ? (rows - 1) / 2 : (value - min) / span * (rows - 1));
  }
  const grid = Array.from({ length: height }, () => new Array(width).fill(0));
  const setDot = (dotX, dotYFromBottom) => {
    const rowFromTop = rows - 1 - Math.round(dotYFromBottom);
    const cellY = Math.floor(rowFromTop / DOTS_PER_CELL_Y);
    const cellX = Math.floor(dotX / DOTS_PER_CELL_X);
    if (cellY < 0 || cellY >= height || cellX < 0 || cellX >= width) {
      return;
    }
    const rowArr = grid[cellY];
    const bit = DOT_MATRIX[rowFromTop % DOTS_PER_CELL_Y][dotX % DOTS_PER_CELL_X];
    rowArr[cellX] = (rowArr[cellX] ?? 0) | bit;
  };
  for (let x = 0; x < cols; x += 1) {
    if (x === 0) {
      setDot(x, dotYs[0]);
      continue;
    }
    const lo = Math.min(dotYs[x - 1], dotYs[x]);
    const hi = Math.max(dotYs[x - 1], dotYs[x]);
    for (let y = Math.round(lo); y <= Math.round(hi); y += 1) {
      setDot(x, y);
    }
  }
  const topLabel = formatValue(max);
  const bottomLabel = formatValue(min);
  const labelWidth = Math.max(topLabel.length, bottomLabel.length);
  return grid.map((row, index) => {
    const label = index === 0 ? topLabel : index === height - 1 ? bottomLabel : "";
    const cells = row.map((mask) => String.fromCharCode(BRAILLE_BASE + mask)).join("");
    return `${label.padStart(labelWidth)} ${AXIS}${cells}`;
  }).join("\n");
}
function barChart(items, options = {}) {
  if (items.length === 0) {
    return MSG_BARS_NO_DATA;
  }
  const barWidth = options.width ?? DEFAULT_BAR_WIDTH;
  const labelWidth = options.labelWidth ?? Math.min(MAX_BAR_LABEL_WIDTH, Math.max(...items.map((item) => item.label.length)));
  const maxAbs = Math.max(...items.map((item) => Math.abs(item.value)), 0);
  return items.map((item) => {
    const scaled = maxAbs === 0 ? 0 : Math.round(Math.abs(item.value) / maxAbs * barWidth);
    const length = item.value !== 0 && scaled === 0 ? 1 : scaled;
    const bar = BAR_FULL.repeat(length).padEnd(barWidth);
    const label = truncate(item.label, labelWidth).padEnd(labelWidth);
    return `${label} ${bar} ${item.note}`;
  }).join("\n");
}

// src/commands/resolve-account.ts
var ACCOUNT_STATUS_OPEN = "ACCOUNT_STATUS_OPEN";
async function resolveAccountId(api, explicitId) {
  const { accounts } = await api.getAccounts();
  if (explicitId) {
    const found = accounts.find((a) => a.id === explicitId);
    if (!found) {
      throw new AppError({
        code: "APP_TINVEST_ACCOUNT_NOT_FOUND",
        userMessage: `\u0421\u0447\u0451\u0442 ${explicitId} \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D \u0441\u0440\u0435\u0434\u0438 \u0432\u0430\u0448\u0438\u0445 \u0441\u0447\u0435\u0442\u043E\u0432. \u0412\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \xABtinvest accounts\xBB, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A.`
      });
    }
    return found.id;
  }
  const open = accounts.filter((a) => a.status === ACCOUNT_STATUS_OPEN);
  const single = open[0];
  if (open.length === 1 && single) {
    return single.id;
  }
  if (open.length === 0) {
    throw new AppError({
      code: "APP_TINVEST_NO_ACCOUNTS",
      userMessage: "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u043D\u0438 \u043E\u0434\u043D\u043E\u0433\u043E \u043E\u0442\u043A\u0440\u044B\u0442\u043E\u0433\u043E \u0441\u0447\u0451\u0442\u0430. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435, \u0447\u0442\u043E \u0442\u043E\u043A\u0435\u043D \u0432\u044B\u043F\u0443\u0449\u0435\u043D \u0434\u043B\u044F \u043D\u0443\u0436\u043D\u043E\u0433\u043E \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0430 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439."
    });
  }
  const list = open.map((a) => `${a.id} (${a.name})`).join(", ");
  throw new AppError({
    code: "APP_TINVEST_ACCOUNT_AMBIGUOUS",
    userMessage: `\u0423 \u0432\u0430\u0441 \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043E\u0442\u043A\u0440\u044B\u0442\u044B\u0445 \u0441\u0447\u0435\u0442\u043E\u0432: ${list}. \u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u043D\u0443\u0436\u043D\u044B\u0439 \u0447\u0435\u0440\u0435\u0437 --account <id>.`
  });
}

// src/commands/allocation.ts
var TYPE_LABELS = {
  share: "\u0430\u043A\u0446\u0438\u0438",
  bond: "\u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u0438",
  etf: "\u0444\u043E\u043D\u0434\u044B",
  currency: "\u0432\u0430\u043B\u044E\u0442\u0430 \u0438 \u043A\u044D\u0448",
  futures: "\u0444\u044C\u044E\u0447\u0435\u0440\u0441\u044B",
  option: "\u043E\u043F\u0446\u0438\u043E\u043D\u044B",
  sp: "\u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u043D\u044B\u0435 \u043D\u043E\u0442\u044B"
};
function toSlices(groups, totalValue) {
  return [...groups.entries()].map(([key, value]) => ({
    key,
    value: round(value),
    weightPercent: totalValue > 0 ? round(value / totalValue * 100) : 0
  })).sort((a, b) => b.value - a.value);
}
function buildAllocationView(params) {
  const { accountId, positions, detailsByUid, totalValue, currency } = params;
  const warnings = [];
  const byType = /* @__PURE__ */ new Map();
  const bySector = /* @__PURE__ */ new Map();
  const byCurrency = /* @__PURE__ */ new Map();
  const byCountry = /* @__PURE__ */ new Map();
  const concentration = [];
  const baseCurrency = currency.toLowerCase();
  const foreignCurrencies = /* @__PURE__ */ new Set();
  for (const position of positions) {
    if (!position.currentPrice) {
      warnings.push(`\u041F\u043E\u0437\u0438\u0446\u0438\u044F ${position.ticker ?? position.figi} \u0431\u0435\u0437 \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u0446\u0435\u043D\u044B \u043D\u0435 \u0443\u0447\u0442\u0435\u043D\u0430 \u0432 \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0435.`);
      continue;
    }
    const value = moneyToNumber(position.currentPrice) * quotationToNumber(position.quantity);
    const details = detailsByUid.get(position.instrumentUid);
    const positionCurrency = position.currentPrice.currency.toLowerCase();
    if (positionCurrency !== baseCurrency) {
      foreignCurrencies.add(positionCurrency);
    }
    const typeLabel = TYPE_LABELS[position.instrumentType] ?? position.instrumentType;
    const sectorLabel = position.instrumentType === "currency" ? "\u0432\u0430\u043B\u044E\u0442\u0430 \u0438 \u043A\u044D\u0448" : details?.sector || "\u0431\u0435\u0437 \u0441\u0435\u043A\u0442\u043E\u0440\u0430";
    const countryLabel = details?.countryOfRiskName || details?.countryOfRisk || "\u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u0430";
    byType.set(typeLabel, (byType.get(typeLabel) ?? 0) + value);
    bySector.set(sectorLabel, (bySector.get(sectorLabel) ?? 0) + value);
    byCurrency.set(position.currentPrice.currency, (byCurrency.get(position.currentPrice.currency) ?? 0) + value);
    byCountry.set(countryLabel, (byCountry.get(countryLabel) ?? 0) + value);
    const weightPercent = totalValue > 0 ? value / totalValue * 100 : 0;
    if (weightPercent >= CONCENTRATION_WARN_PERCENT) {
      concentration.push({
        ticker: position.ticker ?? position.figi,
        name: details?.name ?? null,
        value: round(value),
        weightPercent: round(weightPercent)
      });
    }
  }
  if (foreignCurrencies.size > 0) {
    const foreignList = [...foreignCurrencies].map((c) => c.toUpperCase()).join(", ");
    warnings.push(
      `\u041F\u043E\u0440\u0442\u0444\u0435\u043B\u044C \u043C\u0443\u043B\u044C\u0442\u0438\u0432\u0430\u043B\u044E\u0442\u043D\u044B\u0439 (\u043A\u0440\u043E\u043C\u0435 \u0431\u0430\u0437\u043E\u0432\u043E\u0439 ${baseCurrency.toUpperCase()} \u0435\u0441\u0442\u044C \u043F\u043E\u0437\u0438\u0446\u0438\u0438 \u0432 ${foreignList}). \u0412\u0435\u0441\u0430 \u0438 \u043A\u043E\u043D\u0446\u0435\u043D\u0442\u0440\u0430\u0446\u0438\u044F \u043F\u043E \u043D\u0435\u0440\u0443\u0431\u043B\u0451\u0432\u044B\u043C \u043F\u043E\u0437\u0438\u0446\u0438\u044F\u043C \u043D\u0435\u0442\u043E\u0447\u043D\u044B \u0438 \u0437\u0430\u043D\u0438\u0436\u0435\u043D\u044B: \u0438\u0445 \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u0443\u0447\u0442\u0435\u043D\u0430 \u0432 \u0441\u043E\u0431\u0441\u0442\u0432\u0435\u043D\u043D\u043E\u0439 \u0432\u0430\u043B\u044E\u0442\u0435, \u0430 \u0437\u043D\u0430\u043C\u0435\u043D\u0430\u0442\u0435\u043B\u044C \u2014 \u0440\u0443\u0431\u043B\u0451\u0432\u044B\u0439 \u0438\u0442\u043E\u0433 \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044F; \u043A\u0443\u0440\u0441\u043E\u0432 \u043F\u0435\u0440\u0435\u0441\u0447\u0451\u0442\u0430 \u0432 \u043E\u0442\u0432\u0435\u0442\u0435 GetPortfolio \u043D\u0435\u0442.`
    );
  }
  concentration.sort((a, b) => b.weightPercent - a.weightPercent);
  return {
    accountId,
    totalValue: round(totalValue),
    currency,
    byType: toSlices(byType, totalValue),
    bySector: toSlices(bySector, totalValue),
    byCurrency: toSlices(byCurrency, totalValue),
    byCountry: toSlices(byCountry, totalValue),
    concentration,
    concentrationThresholdPercent: CONCENTRATION_WARN_PERCENT,
    warnings
  };
}
async function fetchAllocation(api, params) {
  const accountId = await resolveAccountId(api, params.explicitAccountId);
  const portfolio = await api.getPortfolio(accountId);
  const positionTypes = new Set(portfolio.positions.map((p) => p.instrumentType));
  const detailsByUid = /* @__PURE__ */ new Map();
  const kinds = ["bonds", "shares", "etfs"].filter(
    (kind) => positionTypes.has(kind === "bonds" ? "bond" : kind === "shares" ? "share" : "etf")
  );
  for (const kind of kinds) {
    const catalog = await loadCatalog(api, kind, params.mode, params.now);
    for (const item of catalog.items) {
      detailsByUid.set(item.uid, {
        uid: item.uid,
        name: item.name,
        sector: item.sector,
        countryOfRisk: item.countryOfRisk,
        countryOfRiskName: "countryOfRiskName" in item ? item.countryOfRiskName : void 0
      });
    }
  }
  return buildAllocationView({
    accountId,
    positions: portfolio.positions,
    detailsByUid,
    totalValue: moneyToNumber(portfolio.totalAmountPortfolio),
    currency: portfolio.totalAmountPortfolio.currency
  });
}
function renderSlices(title, slices) {
  const table = renderTable(
    ["\u0413\u0440\u0443\u043F\u043F\u0430", "\u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C", "\u0414\u043E\u043B\u044F"],
    slices.map((s) => [s.key, formatAmount(s.value), `${formatAmount(s.weightPercent, 1)} %`])
  );
  return `${title}
${table}`;
}
function renderAllocation(view) {
  const parts = [
    `\u0421\u0447\u0451\u0442: ${view.accountId}`,
    `\u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044F: ${formatAmount(view.totalValue)} ${view.currency.toUpperCase()}`,
    "",
    renderSlices("\u041F\u043E \u043A\u043B\u0430\u0441\u0441\u0430\u043C \u0430\u043A\u0442\u0438\u0432\u043E\u0432:", view.byType),
    "",
    renderSlices("\u041F\u043E \u0441\u0435\u043A\u0442\u043E\u0440\u0430\u043C:", view.bySector),
    "",
    renderSlices("\u041F\u043E \u0432\u0430\u043B\u044E\u0442\u0430\u043C:", view.byCurrency),
    "",
    renderSlices("\u041F\u043E \u0441\u0442\u0440\u0430\u043D\u0430\u043C \u0440\u0438\u0441\u043A\u0430:", view.byCountry)
  ];
  if (view.concentration.length > 0) {
    parts.push("", `\u041A\u043E\u043D\u0446\u0435\u043D\u0442\u0440\u0430\u0446\u0438\u044F (\u043F\u043E\u0437\u0438\u0446\u0438\u0438 \u2265 ${view.concentrationThresholdPercent}% \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044F):`);
    for (const entry of view.concentration) {
      parts.push(
        `  ${entry.ticker}${entry.name ? ` (${entry.name})` : ""} \u2014 ${formatAmount(entry.weightPercent, 1)} %`
      );
    }
  }
  for (const warning of view.warnings) {
    parts.push("", `\u26A0 ${warning}`);
  }
  return parts.join("\n");
}
function renderAllocationChart(view) {
  const toItem = (slice) => ({
    label: slice.key,
    value: slice.weightPercent,
    note: `${formatAmount(slice.weightPercent, 1)} %`
  });
  return [
    "\u0421\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430 \u043F\u043E \u0441\u0435\u043A\u0442\u043E\u0440\u0430\u043C (\u0434\u043E\u043B\u044F \u043E\u0442 \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u0438):",
    barChart(view.bySector.map(toItem)),
    "",
    "\u041F\u043E \u043A\u043B\u0430\u0441\u0441\u0430\u043C \u0430\u043A\u0442\u0438\u0432\u043E\u0432:",
    barChart(view.byType.map(toItem))
  ].join("\n");
}

// src/commands/cash.ts
function toAmounts(values) {
  return (values ?? []).map((m) => ({ currency: m.currency, amount: moneyToNumber(m) })).filter((a) => a.amount !== 0).sort((a, b) => b.amount - a.amount);
}
function buildCashView(accountId, resp) {
  return {
    accountId,
    available: toAmounts(resp.money),
    blocked: toAmounts(resp.blocked),
    blockedGuarantee: toAmounts(resp.blockedGuarantee)
  };
}
async function fetchCash(api, explicitAccountId) {
  const accountId = await resolveAccountId(api, explicitAccountId);
  const resp = await api.getWithdrawLimits(accountId);
  return buildCashView(accountId, resp);
}
function renderAmounts(title, amounts) {
  if (amounts.length === 0) {
    return [];
  }
  return [
    title,
    ...amounts.map((a) => `  ${formatAmount(a.amount)} ${a.currency.toUpperCase()}`)
  ];
}
function renderCash(view) {
  const lines = [
    `\u0421\u0447\u0451\u0442: ${view.accountId}`,
    ...renderAmounts("\u0421\u0432\u043E\u0431\u043E\u0434\u043D\u044B\u0435 \u0434\u0435\u043D\u044C\u0433\u0438:", view.available),
    ...renderAmounts("\u0417\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u043E \u043F\u043E\u0434 \u0437\u0430\u044F\u0432\u043A\u0438:", view.blocked),
    ...renderAmounts("\u0413\u0430\u0440\u0430\u043D\u0442\u0438\u0439\u043D\u043E\u0435 \u043E\u0431\u0435\u0441\u043F\u0435\u0447\u0435\u043D\u0438\u0435:", view.blockedGuarantee)
  ];
  if (view.available.length === 0 && view.blocked.length === 0 && view.blockedGuarantee.length === 0) {
    lines.push("\u0421\u0432\u043E\u0431\u043E\u0434\u043D\u044B\u0445 \u0434\u0435\u043D\u0435\u0433 \u043D\u0430 \u0441\u0447\u0451\u0442\u0435 \u043D\u0435\u0442.");
  }
  return lines.join("\n");
}

// src/format/datetime.ts
var MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1e3;
function pad2(value) {
  return String(value).padStart(2, "0");
}
function moscowParts(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return null;
  }
  const shifted = new Date(ms + MOSCOW_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes()
  };
}
function formatMoscowDateTime(iso) {
  const p = moscowParts(iso);
  if (!p) {
    return iso;
  }
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hours)}:${pad2(p.minutes)}`;
}
function formatMoscowDate(iso) {
  const p = moscowParts(iso);
  if (!p) {
    return iso;
  }
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}
function formatMoscowTime(iso) {
  const p = moscowParts(iso);
  if (!p) {
    return iso;
  }
  return `${pad2(p.hours)}:${pad2(p.minutes)}`;
}

// src/util/concurrency.ts
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function mapWithConcurrency(items, options, fn) {
  const { concurrency, minIntervalMs = 0 } = options;
  const sleep = options.sleepFn ?? defaultSleep;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`mapWithConcurrency: concurrency \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043F\u043E\u043B\u043E\u0436\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u043C \u0446\u0435\u043B\u044B\u043C, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E ${concurrency}`);
  }
  const results = new Array(items.length);
  let cursor = 0;
  let nextStartAt = Date.now();
  let failed = false;
  async function worker() {
    while (!failed) {
      const index = cursor;
      if (index >= items.length) {
        return;
      }
      cursor += 1;
      if (minIntervalMs > 0) {
        const waitMs = nextStartAt - Date.now();
        nextStartAt = Math.max(nextStartAt, Date.now()) + minIntervalMs;
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// src/commands/bond-math.ts
function couponAmount(coupon) {
  if (!coupon.payOneBond) {
    return null;
  }
  const value = moneyToNumber(coupon.payOneBond);
  return value > 0 ? value : null;
}
var YTM_RATE_MIN = -0.9;
var YTM_RATE_MAX = 10;
var YTM_TOLERANCE = 1e-10;
var YTM_MAX_ITERATIONS = 200;
function presentValue(flows, rate, settlement) {
  return flows.reduce((sum, flow) => {
    const years = (flow.date.getTime() - settlement.getTime()) / MS_PER_YEAR;
    return sum + flow.amount / Math.pow(1 + rate, years);
  }, 0);
}
function futureFlows(flows, settlement) {
  return flows.filter((f) => f.date.getTime() > settlement.getTime() && f.amount > 0);
}
function computeEffectiveYtmPercent(flows, dirtyPrice, settlement) {
  if (!(dirtyPrice > 0)) {
    return null;
  }
  const future = futureFlows(flows, settlement);
  if (future.length === 0) {
    return null;
  }
  let low = YTM_RATE_MIN;
  let high = YTM_RATE_MAX;
  const npvAt = (rate) => presentValue(future, rate, settlement) - dirtyPrice;
  if (npvAt(low) < 0 || npvAt(high) > 0) {
    return null;
  }
  for (let i = 0; i < YTM_MAX_ITERATIONS && high - low > YTM_TOLERANCE; i += 1) {
    const mid = (low + high) / 2;
    if (npvAt(mid) > 0) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2 * 100;
}
function computeMacaulayDurationYears(flows, ytmPercent, settlement) {
  const future = futureFlows(flows, settlement);
  if (future.length === 0) {
    return null;
  }
  const rate = ytmPercent / 100;
  let weightedYears = 0;
  let totalPv = 0;
  for (const flow of future) {
    const years = (flow.date.getTime() - settlement.getTime()) / MS_PER_YEAR;
    const pv = flow.amount / Math.pow(1 + rate, years);
    weightedYears += years * pv;
    totalPv += pv;
  }
  if (totalPv <= 0) {
    return null;
  }
  return weightedYears / totalPv;
}
function computeCurrentCouponYieldPercent(annualCouponAmount, cleanPrice) {
  if (annualCouponAmount === null || !(annualCouponAmount > 0) || !(cleanPrice > 0)) {
    return null;
  }
  return annualCouponAmount / cleanPrice * 100;
}

// src/commands/income.ts
function moscowDayStart(now) {
  const shifted = new Date(now.getTime() + MOSCOW_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MOSCOW_OFFSET_MS);
}
function couponEvents(position, name, coupons, warnings) {
  const quantity = quotationToNumber(position.quantity);
  const ticker = position.ticker ?? position.figi;
  const events = [];
  let unknownCoupons = 0;
  for (const coupon of coupons) {
    const perUnit = couponAmount(coupon);
    if (perUnit === null) {
      unknownCoupons += 1;
      continue;
    }
    events.push({
      date: coupon.couponDate.slice(0, 10),
      ticker,
      name,
      kind: "coupon",
      perUnit: round(perUnit),
      quantity,
      total: round(perUnit * quantity),
      // perUnit не null ⇒ payOneBond заведомо присутствует.
      currency: coupon.payOneBond.currency
    });
  }
  if (unknownCoupons > 0) {
    warnings.push(
      `${ticker}: \u0443 ${unknownCoupons} \u0431\u0443\u0434\u0443\u0449\u0438\u0445 \u043A\u0443\u043F\u043E\u043D\u043E\u0432 \u0441\u0443\u043C\u043C\u0430 \u0435\u0449\u0451 \u043D\u0435 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0430 \u2014 \u043E\u043D\u0438 \u043D\u0435 \u0432\u043E\u0448\u043B\u0438 \u0432 \u043A\u0430\u043B\u0435\u043D\u0434\u0430\u0440\u044C.`
    );
  }
  return events;
}
function dividendEvents(position, name, dividends, todayStartMs) {
  const quantity = quotationToNumber(position.quantity);
  const ticker = position.ticker ?? position.figi;
  const events = [];
  for (const dividend of dividends) {
    if (dividend.dividendType === "Cancelled" || !dividend.dividendNet) {
      continue;
    }
    const date = dividend.paymentDate ?? dividend.recordDate;
    if (!date || Date.parse(date) < todayStartMs) {
      continue;
    }
    const perUnit = moneyToNumber(dividend.dividendNet);
    if (perUnit <= 0) {
      continue;
    }
    events.push({
      date: date.slice(0, 10),
      ticker,
      name,
      kind: "dividend",
      perUnit: round(perUnit),
      quantity,
      total: round(perUnit * quantity),
      currency: dividend.dividendNet.currency
    });
  }
  return events;
}
function buildIncomeView(params) {
  const warnings = [];
  const events = [];
  const todayStartMs = moscowDayStart(params.now).getTime();
  for (const position of params.positions) {
    const name = params.namesByUid.get(position.instrumentUid) ?? null;
    if (position.instrumentType === "bond") {
      const coupons = params.couponsByUid.get(position.instrumentUid) ?? [];
      events.push(...couponEvents(position, name, coupons, warnings));
    } else if (position.instrumentType === "share" || position.instrumentType === "etf") {
      const dividends = params.dividendsByUid.get(position.instrumentUid) ?? [];
      events.push(...dividendEvents(position, name, dividends, todayStartMs));
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));
  const monthly = /* @__PURE__ */ new Map();
  let horizonTotal = 0;
  const foreignCurrencies = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.currency !== "rub") {
      foreignCurrencies.add(event.currency);
      continue;
    }
    const month = event.date.slice(0, 7);
    monthly.set(month, (monthly.get(month) ?? 0) + event.total);
    horizonTotal += event.total;
  }
  if (foreignCurrencies.size > 0) {
    warnings.push(
      `\u0412\u044B\u043F\u043B\u0430\u0442\u044B \u0432 \u0432\u0430\u043B\u044E\u0442\u0430\u0445 (${[...foreignCurrencies].sort().join(", ")}) \u043F\u043E\u043A\u0430\u0437\u0430\u043D\u044B \u0432 \u043A\u0430\u043B\u0435\u043D\u0434\u0430\u0440\u0435, \u043D\u043E \u043D\u0435 \u0432\u0445\u043E\u0434\u044F\u0442 \u0432 \u0440\u0443\u0431\u043B\u0451\u0432\u044B\u0435 \u0438\u0442\u043E\u0433\u0438.`
    );
  }
  return {
    accountId: params.accountId,
    from: params.from,
    to: params.to,
    events,
    monthlyTotals: [...monthly.entries()].map(([month, total]) => ({ month, total: round(total) })).sort((a, b) => a.month.localeCompare(b.month)),
    horizonTotal: round(horizonTotal),
    warnings
  };
}
async function fetchIncome(api, params) {
  const accountId = await resolveAccountId(api, params.explicitAccountId);
  const portfolio = await api.getPortfolio(accountId);
  const windowStart = moscowDayStart(params.now);
  const from = windowStart.toISOString();
  const to = new Date(windowStart.getTime() + INCOME_HORIZON_DAYS * MS_PER_DAY).toISOString();
  const bondPositions = portfolio.positions.filter((p) => p.instrumentType === "bond");
  const dividendPositions = portfolio.positions.filter(
    (p) => p.instrumentType === "share" || p.instrumentType === "etf"
  );
  const incomePositions = [...bondPositions, ...dividendPositions];
  const throttle = { concurrency: BATCH_CONCURRENCY, minIntervalMs: BATCH_MIN_INTERVAL_MS };
  const [names, coupons, dividends] = await Promise.all([
    mapWithConcurrency(incomePositions, throttle, async (p) => {
      const { instrument } = await api.getInstrumentByUid(p.instrumentUid);
      return [p.instrumentUid, instrument.name];
    }),
    mapWithConcurrency(bondPositions, throttle, async (p) => {
      const resp = await api.getBondCoupons(p.instrumentUid, from, to);
      return [p.instrumentUid, resp.events ?? []];
    }),
    mapWithConcurrency(dividendPositions, throttle, async (p) => {
      const resp = await api.getDividends(p.instrumentUid, from, to);
      return [p.instrumentUid, resp.dividends ?? []];
    })
  ]);
  return buildIncomeView({
    accountId,
    from,
    to,
    positions: incomePositions,
    namesByUid: new Map(names),
    couponsByUid: new Map(coupons),
    dividendsByUid: new Map(dividends),
    now: params.now
  });
}
function renderIncome(view) {
  const parts = [
    `\u0421\u0447\u0451\u0442: ${view.accountId}`,
    `\u0413\u043E\u0440\u0438\u0437\u043E\u043D\u0442: ${view.from.slice(0, 10)} \u2014 ${view.to.slice(0, 10)}`,
    ""
  ];
  if (view.events.length === 0) {
    parts.push("\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u043D\u044B\u0445 \u0431\u0443\u0434\u0443\u0449\u0438\u0445 \u0432\u044B\u043F\u043B\u0430\u0442 \u043F\u043E \u043F\u043E\u0437\u0438\u0446\u0438\u044F\u043C \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044F \u043D\u0435\u0442.");
  } else {
    parts.push(
      renderTable(
        ["\u0414\u0430\u0442\u0430", "\u0422\u0438\u043A\u0435\u0440", "\u0422\u0438\u043F", "\u041D\u0430 \u0431\u0443\u043C\u0430\u0433\u0443", "\u041A\u043E\u043B-\u0432\u043E", "\u0421\u0443\u043C\u043C\u0430", "\u0412\u0430\u043B\u044E\u0442\u0430"],
        view.events.map((e) => [
          e.date,
          e.ticker,
          e.kind === "coupon" ? "\u043A\u0443\u043F\u043E\u043D" : "\u0434\u0438\u0432\u0438\u0434\u0435\u043D\u0434",
          formatAmount(e.perUnit),
          formatAmount(e.quantity, 0),
          formatAmount(e.total),
          e.currency.toUpperCase()
        ])
      ),
      "",
      "\u0418\u0442\u043E\u0433\u043E \u043F\u043E \u043C\u0435\u0441\u044F\u0446\u0430\u043C (RUB):",
      ...view.monthlyTotals.map((m) => `  ${m.month}: ${formatAmount(m.total)}`),
      "",
      `\u0412\u0441\u0435\u0433\u043E \u0437\u0430 \u0433\u043E\u0440\u0438\u0437\u043E\u043D\u0442: ${formatAmount(view.horizonTotal)} RUB`
    );
  }
  for (const warning of view.warnings) {
    parts.push("", `\u26A0 ${warning}`);
  }
  return parts.join("\n");
}
var CHART_MONTH_LABELS = ["\u044F\u043D\u0432", "\u0444\u0435\u0432", "\u043C\u0430\u0440", "\u0430\u043F\u0440", "\u043C\u0430\u0439", "\u0438\u044E\u043D", "\u0438\u044E\u043B", "\u0430\u0432\u0433", "\u0441\u0435\u043D", "\u043E\u043A\u0442", "\u043D\u043E\u044F", "\u0434\u0435\u043A"];
var CHART_INCOME_BAR_WIDTH = 30;
var CHART_INCOME_LABEL_WIDTH = 8;
function formatMonthLabel(month) {
  const [year = "", mon = ""] = month.split("-");
  const label = CHART_MONTH_LABELS[Number(mon) - 1] ?? mon;
  return `${label} ${year.slice(2)}`;
}
function renderIncomeChart(view) {
  if (view.monthlyTotals.length === 0) {
    return "\u0413\u0440\u0430\u0444\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: \u043D\u0435\u0442 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u043D\u044B\u0445 \u0440\u0443\u0431\u043B\u0451\u0432\u044B\u0445 \u0432\u044B\u043F\u043B\u0430\u0442 \u0432 \u0433\u043E\u0440\u0438\u0437\u043E\u043D\u0442\u0435.";
  }
  const items = view.monthlyTotals.map((m) => ({
    label: formatMonthLabel(m.month),
    value: m.total,
    note: `${formatAmount(m.total, 0)} \u20BD`
  }));
  return [
    `\u041F\u0430\u0441\u0441\u0438\u0432\u043D\u044B\u0439 \u0434\u043E\u0445\u043E\u0434 \u043F\u043E \u043C\u0435\u0441\u044F\u0446\u0430\u043C (\u0438\u0442\u043E\u0433\u043E ${formatAmount(view.horizonTotal, 0)} \u20BD):`,
    barChart(items, { width: CHART_INCOME_BAR_WIDTH, labelWidth: CHART_INCOME_LABEL_WIDTH })
  ].join("\n");
}

// src/analytics/xirr.ts
var RATE_GRID = [
  -0.99,
  -0.95,
  -0.9,
  -0.8,
  -0.7,
  -0.6,
  -0.5,
  -0.4,
  -0.3,
  -0.2,
  -0.1,
  -0.05,
  0,
  0.05,
  0.1,
  0.2,
  0.3,
  0.5,
  0.75,
  1,
  1.5,
  2,
  3,
  5,
  10
];
var XIRR_TOLERANCE = 1e-10;
var XIRR_MAX_ITERATIONS = 200;
var MIN_SPAN_MS = 24 * 3600 * 1e3;
function npv(flows, rate, t0) {
  return flows.reduce((sum, flow) => {
    const years = (flow.date.getTime() - t0) / MS_PER_YEAR;
    return sum + flow.amount / Math.pow(1 + rate, years);
  }, 0);
}
function computeXirrPercent(flows) {
  const hasNegative = flows.some((f2) => f2.amount < 0);
  const hasPositive = flows.some((f2) => f2.amount > 0);
  if (flows.length < 2 || !hasNegative || !hasPositive) {
    return null;
  }
  const times = flows.map((f2) => f2.date.getTime());
  const t0 = Math.min(...times);
  if (Math.max(...times) - t0 < MIN_SPAN_MS) {
    return null;
  }
  const f = (rate) => npv(flows, rate, t0);
  const profitable = f(0) >= 0;
  const zeroIndex = RATE_GRID.indexOf(0);
  let bracket = null;
  if (profitable) {
    for (let i = zeroIndex; i < RATE_GRID.length - 1 && !bracket; i += 1) {
      if (f(RATE_GRID[i]) * f(RATE_GRID[i + 1]) <= 0) {
        bracket = [RATE_GRID[i], RATE_GRID[i + 1]];
      }
    }
  } else {
    for (let i = zeroIndex; i > 0 && !bracket; i -= 1) {
      if (f(RATE_GRID[i - 1]) * f(RATE_GRID[i]) <= 0) {
        bracket = [RATE_GRID[i - 1], RATE_GRID[i]];
      }
    }
  }
  if (!bracket) {
    return null;
  }
  let [low, high] = bracket;
  let fLow = f(low);
  for (let i = 0; i < XIRR_MAX_ITERATIONS && high - low > XIRR_TOLERANCE; i += 1) {
    const mid = (low + high) / 2;
    const fMid = f(mid);
    if (fLow * fMid <= 0) {
      high = mid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return (low + high) / 2 * 100;
}

// src/format/values.ts
var DASH = "\u2014";
var DEFAULT_DIGITS = 2;
function formatOrDash(value, digits = DEFAULT_DIGITS) {
  return value === null || value === void 0 ? DASH : value.toFixed(digits);
}
function percentOrDash(value, digits = DEFAULT_DIGITS) {
  return value === null || value === void 0 ? DASH : `${value.toFixed(digits)}%`;
}
function moneyOrDash(value, digits = DEFAULT_DIGITS) {
  return value === null || value === void 0 ? DASH : formatAmount(value, digits);
}

// src/commands/operations.ts
function emptyToNull(value) {
  return value ? value : null;
}
function computeOperationsRange(days, now) {
  return {
    from: new Date(now.getTime() - days * MS_PER_DAY).toISOString(),
    to: now.toISOString()
  };
}
async function fetchAllOperationItems(api, params) {
  const items = [];
  let cursor;
  for (let page = 0; page < MAX_OPERATIONS_PAGES; page += 1) {
    const resp = await api.getOperationsByCursor({ ...params, cursor, limit: OPERATIONS_PAGE_LIMIT });
    items.push(...resp.items ?? []);
    if (!resp.hasNext || !resp.nextCursor) {
      return items;
    }
    cursor = resp.nextCursor;
  }
  throw new AppError({
    code: "APP_TINVEST_TOO_MANY_OPERATIONS",
    userMessage: `\u0418\u0441\u0442\u043E\u0440\u0438\u044F \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0439 \u043F\u0440\u0435\u0432\u044B\u0441\u0438\u043B\u0430 ${MAX_OPERATIONS_PAGES * OPERATIONS_PAGE_LIMIT} \u0437\u0430\u043F\u0438\u0441\u0435\u0439 \u0437\u0430 \u043F\u0435\u0440\u0438\u043E\u0434. \u0421\u0443\u0437\u044C\u0442\u0435 \u043F\u0435\u0440\u0438\u043E\u0434 \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 --days.`
  });
}
function buildOperationViews(items) {
  return [...items].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map((op) => ({
    id: op.id,
    date: op.date,
    // Человекочитаемое описание от API; цепочка допустима — чистая презентация.
    description: op.description || op.type || "\u2014",
    operationType: emptyToNull(op.type),
    instrumentName: emptyToNull(op.name),
    ticker: emptyToNull(op.ticker),
    payment: op.payment ? moneyToNumber(op.payment) : null,
    currency: op.payment?.currency ?? null,
    // Нулевая комиссия у операций без комиссии — отсутствие данных, не 0.
    commission: op.commission && moneyToNumber(op.commission) !== 0 ? moneyToNumber(op.commission) : null,
    figi: emptyToNull(op.figi),
    // «0» у операций без количества (дивиденды, комиссии) — показываем null, не 0.
    quantity: op.quantity && op.quantity !== "0" ? Number(op.quantity) : null,
    // Нулевая «цена» у неторговых операций (пополнение, комиссия) —
    // это отсутствие цены, а не цена 0 (живой кейс из песочницы).
    price: op.price && moneyToNumber(op.price) !== 0 ? moneyToNumber(op.price) : null
  }));
}
async function fetchOperations(api, params) {
  const accountId = await resolveAccountId(api, params.explicitAccountId);
  const { from, to } = computeOperationsRange(params.days, params.now);
  const items = await fetchAllOperationItems(api, { accountId, from, to });
  return { accountId, from, to, operations: buildOperationViews(items) };
}
function renderOperations(result) {
  const header = [
    `\u0421\u0447\u0451\u0442: ${result.accountId}`,
    `\u041F\u0435\u0440\u0438\u043E\u0434: ${formatMoscowDate(result.from)} \u2014 ${formatMoscowDate(result.to)}`,
    `\u041E\u043F\u0435\u0440\u0430\u0446\u0438\u0439: ${result.operations.length}`,
    ""
  ].join("\n");
  if (result.operations.length === 0) {
    return `${header}\u0417\u0430 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u043F\u0435\u0440\u0438\u043E\u0434 \u0438\u0441\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0445 \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0439 \u043D\u0435\u0442.`;
  }
  const table = renderTable(
    ["\u0414\u0430\u0442\u0430", "\u041E\u043F\u0435\u0440\u0430\u0446\u0438\u044F", "\u0422\u0438\u043A\u0435\u0440", "\u0421\u0443\u043C\u043C\u0430", "\u0412\u0430\u043B\u044E\u0442\u0430", "\u041A\u043E\u043B-\u0432\u043E", "\u0426\u0435\u043D\u0430", "\u041A\u043E\u043C\u0438\u0441\u0441\u0438\u044F"],
    result.operations.map((op) => [
      // Время операции — в МСК: голый срез UTC смещал бы время на -3ч, а у
      // ночных/вечерних сделок уводил бы календарную дату на день назад.
      formatMoscowDateTime(op.date),
      op.description,
      op.ticker ?? DASH,
      op.payment !== null ? formatSigned(op.payment) : DASH,
      op.currency !== null ? op.currency.toUpperCase() : DASH,
      op.quantity !== null ? formatAmount(op.quantity, 0) : DASH,
      op.price !== null ? formatAmount(op.price) : DASH,
      op.commission !== null ? formatSigned(op.commission) : DASH
    ])
  );
  return `${header}${table}`;
}

// src/commands/performance.ts
function classifyOperationType(type) {
  if (!type) {
    return "other";
  }
  if (type === "OPERATION_TYPE_INPUT_SECURITIES" || type === "OPERATION_TYPE_OUTPUT_SECURITIES") {
    return "securities-transfer";
  }
  if (type.includes("TAX")) {
    return "tax";
  }
  if (type.includes("FEE")) {
    return "commission";
  }
  if (type.includes("DIVIDEND")) {
    return "dividend";
  }
  if (type.includes("COUPON")) {
    return "coupon";
  }
  if (type.startsWith("OPERATION_TYPE_INPUT")) {
    return "input";
  }
  if (type.startsWith("OPERATION_TYPE_OUTPUT")) {
    return "output";
  }
  if (type.includes("BUY") || type.includes("SELL")) {
    return "trade";
  }
  return "other";
}
var MONETARY_BUCKETS = /* @__PURE__ */ new Set([
  "input",
  "output",
  "dividend",
  "coupon",
  "commission",
  "tax",
  "trade"
]);
function buildPerformanceView(params) {
  const { accountId, from, to, items, currentValue, now } = params;
  const warnings = [];
  const flows = [];
  let invested = 0;
  let withdrawn = 0;
  const breakdown = { dividends: 0, coupons: 0, commissions: 0, taxes: 0 };
  const skippedCurrencies = /* @__PURE__ */ new Set();
  let hasSecuritiesTransfer = false;
  let skippedNoPayment = 0;
  for (const op of items) {
    const bucket = classifyOperationType(op.type ?? null);
    if (bucket === "securities-transfer") {
      hasSecuritiesTransfer = true;
      continue;
    }
    if (!op.payment) {
      if (MONETARY_BUCKETS.has(bucket)) {
        skippedNoPayment += 1;
      }
      continue;
    }
    if (op.payment.currency !== "rub") {
      skippedCurrencies.add(op.payment.currency);
      continue;
    }
    const amount = moneyToNumber(op.payment);
    switch (bucket) {
      case "input":
        invested += amount;
        flows.push({ date: new Date(op.date), amount: -amount });
        break;
      case "output":
        withdrawn += -amount;
        flows.push({ date: new Date(op.date), amount: -amount });
        break;
      case "dividend":
        breakdown.dividends += amount;
        break;
      case "coupon":
        breakdown.coupons += amount;
        break;
      case "commission":
        breakdown.commissions += amount;
        break;
      case "tax":
        breakdown.taxes += amount;
        break;
      default:
        break;
    }
  }
  if (skippedCurrencies.size > 0) {
    warnings.push(
      `\u041E\u043F\u0435\u0440\u0430\u0446\u0438\u0438 \u0432 \u0432\u0430\u043B\u044E\u0442\u0430\u0445 (${[...skippedCurrencies].sort().join(", ")}) \u043D\u0435 \u0432\u0445\u043E\u0434\u044F\u0442 \u0432 \u0440\u0430\u0441\u0447\u0451\u0442 \u2014 \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043F\u043E\u0441\u0447\u0438\u0442\u0430\u043D\u0430 \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u043E \u0440\u0443\u0431\u043B\u0451\u0432\u044B\u043C \u043F\u043E\u0442\u043E\u043A\u0430\u043C.`
    );
  }
  if (hasSecuritiesTransfer) {
    warnings.push(
      "\u041F\u043E \u0441\u0447\u0451\u0442\u0443 \u0431\u044B\u043B\u0438 \u043F\u0435\u0440\u0435\u0432\u043E\u0434\u044B \u0446\u0435\u043D\u043D\u044B\u0445 \u0431\u0443\u043C\u0430\u0433 (\u0437\u0430\u0432\u043E\u0434/\u0432\u044B\u0432\u043E\u0434) \u2014 \u0438\u0445 \u0434\u0435\u043D\u0435\u0436\u043D\u0430\u044F \u043E\u0446\u0435\u043D\u043A\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430, XIRR \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u0438\u0441\u043A\u0430\u0436\u0451\u043D."
    );
  }
  if (skippedNoPayment > 0) {
    warnings.push(
      `${skippedNoPayment} \u0434\u0435\u043D\u0435\u0436\u043D\u044B\u0445 \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0439 \u0431\u0435\u0437 \u0441\u0443\u043C\u043C\u044B \u043F\u043B\u0430\u0442\u0435\u0436\u0430 \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u044B \u0438\u0437 \u0440\u0430\u0441\u0447\u0451\u0442\u0430 \u2014 \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u043E\u043B\u043D\u043E\u0439.`
    );
  }
  const flowsWithFinal = currentValue > 0 ? [...flows, { date: now, amount: currentValue }] : flows;
  const xirrPercent = computeXirrPercent(flowsWithFinal);
  if (xirrPercent === null && flows.length > 0) {
    warnings.push("XIRR \u043D\u0435 \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u0430\u043D: \u043D\u0435\u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u0440\u0430\u0437\u043D\u043E\u0437\u043D\u0430\u043A\u043E\u0432\u044B\u0445 \u0434\u0435\u043D\u0435\u0436\u043D\u044B\u0445 \u043F\u043E\u0442\u043E\u043A\u043E\u0432 \u0437\u0430 \u043F\u0435\u0440\u0438\u043E\u0434.");
  }
  if (xirrPercent !== null && Math.abs(xirrPercent) > EXTREME_XIRR_WARN_PERCENT) {
    warnings.push(
      "XIRR \u044D\u043A\u0441\u0442\u0440\u0435\u043C\u0430\u043B\u0435\u043D \u0438\u0437-\u0437\u0430 \u0447\u0430\u0441\u0442\u044B\u0445 \u043F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0439/\u0432\u044B\u0432\u043E\u0434\u043E\u0432 \u043F\u0440\u0438 \u043D\u0435\u0431\u043E\u043B\u044C\u0448\u043E\u043C \u0440\u0430\u0431\u043E\u0442\u0430\u044E\u0449\u0435\u043C \u043A\u0430\u043F\u0438\u0442\u0430\u043B\u0435 \u2014 \u043E\u0440\u0438\u0435\u043D\u0442\u0438\u0440\u0443\u0439\u0442\u0435\u0441\u044C \u0432 \u043F\u0435\u0440\u0432\u0443\u044E \u043E\u0447\u0435\u0440\u0435\u0434\u044C \u043D\u0430 \u0447\u0438\u0441\u0442\u044B\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u0432 \u0440\u0443\u0431\u043B\u044F\u0445."
    );
  }
  const netProfit = currentValue + withdrawn - invested;
  return {
    accountId,
    from,
    to,
    currency: "rub",
    invested: round(invested),
    withdrawn: round(withdrawn),
    currentValue: round(currentValue),
    netProfit: round(netProfit),
    netProfitPercent: invested > 0 ? round(netProfit / invested * 100) : null,
    xirrPercent: xirrPercent !== null ? round(xirrPercent) : null,
    breakdown: {
      dividends: round(breakdown.dividends),
      coupons: round(breakdown.coupons),
      commissions: round(breakdown.commissions),
      taxes: round(breakdown.taxes)
    },
    operationsCount: items.length,
    warnings
  };
}
async function fetchPerformance(api, params) {
  const { accounts } = await api.getAccounts();
  const accountId = await resolveAccountId(
    { getAccounts: async () => ({ accounts }) },
    params.explicitAccountId
  );
  const account = accounts.find((a) => a.id === accountId);
  if (!account?.openedDate) {
    throw new AppError({
      code: "APP_TINVEST_ACCOUNT_OPEN_DATE_MISSING",
      userMessage: "API \u043D\u0435 \u0432\u0435\u0440\u043D\u0443\u043B \u0434\u0430\u0442\u0443 \u043E\u0442\u043A\u0440\u044B\u0442\u0438\u044F \u0441\u0447\u0451\u0442\u0430 \u2014 \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u0430\u0442\u044C \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u0441 \u043D\u0430\u0447\u0430\u043B\u0430 \u0438\u043D\u0432\u0435\u0441\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u044F \u043D\u0435\u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E."
    });
  }
  const from = new Date(account.openedDate).toISOString();
  const to = params.now.toISOString();
  const [items, portfolio] = await Promise.all([
    fetchAllOperationItems(api, { accountId, from, to }),
    api.getPortfolio(accountId)
  ]);
  return buildPerformanceView({
    accountId,
    from,
    to,
    items,
    currentValue: moneyToNumber(portfolio.totalAmountPortfolio),
    now: params.now
  });
}
function renderPerformance(view) {
  const lines = [
    `\u0421\u0447\u0451\u0442: ${view.accountId}`,
    `\u041F\u0435\u0440\u0438\u043E\u0434: ${view.from.slice(0, 10)} \u2014 ${view.to.slice(0, 10)} (\u0441 \u043E\u0442\u043A\u0440\u044B\u0442\u0438\u044F \u0441\u0447\u0451\u0442\u0430)`,
    "",
    `\u0412\u043B\u043E\u0436\u0435\u043D\u043E (\u043F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F):     ${formatAmount(view.invested)} RUB`,
    `\u0412\u044B\u0432\u0435\u0434\u0435\u043D\u043E:                 ${formatAmount(view.withdrawn)} RUB`,
    `\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C:        ${formatAmount(view.currentValue)} RUB`,
    `\u0427\u0438\u0441\u0442\u044B\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442:         ${formatSigned(view.netProfit)} RUB` + (view.netProfitPercent !== null ? ` (${formatSigned(view.netProfitPercent)} % \u043A \u0432\u043B\u043E\u0436\u0435\u043D\u043D\u043E\u043C\u0443)` : ""),
    `\u0413\u043E\u0434\u043E\u0432\u0430\u044F \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C XIRR:  ${view.xirrPercent !== null ? `${formatSigned(view.xirrPercent)} %` : DASH}`,
    "",
    "\u0417\u0430 \u043F\u0435\u0440\u0438\u043E\u0434 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E/\u0443\u043F\u043B\u0430\u0447\u0435\u043D\u043E:",
    `  \u0414\u0438\u0432\u0438\u0434\u0435\u043D\u0434\u044B: ${formatSigned(view.breakdown.dividends)}`,
    `  \u041A\u0443\u043F\u043E\u043D\u044B:    ${formatSigned(view.breakdown.coupons)}`,
    `  \u041A\u043E\u043C\u0438\u0441\u0441\u0438\u0438:  ${formatSigned(view.breakdown.commissions)}`,
    `  \u041D\u0430\u043B\u043E\u0433\u0438:    ${formatSigned(view.breakdown.taxes)}`
  ];
  for (const warning of view.warnings) {
    lines.push("", `\u26A0 ${warning}`);
  }
  return lines.join("\n");
}

// src/cli/runtime.ts
var import_dotenv = __toESM(require_main(), 1);
var import_node_fs3 = __toESM(require("node:fs"), 1);

// src/api/client.ts
var API_CONTRACT_PREFIX = "tinkoff.public.invest.api.contract.v1";
var TInvestClient = class {
  token;
  baseUrl;
  timeoutMs;
  fetchFn;
  constructor(options) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? T_INVEST_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
  }
  async call(methodPath, body) {
    const url = `${this.baseUrl}/${API_CONTRACT_PREFIX}.${methodPath}`;
    let response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        throw new AppError({
          code: "APP_TINVEST_TIMEOUT",
          userMessage: `\u0421\u0435\u0440\u0432\u0435\u0440 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B \u0437\u0430 ${Math.round(this.timeoutMs / 1e3)} \u0441\u0435\u043A\u0443\u043D\u0434. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0437\u0430\u043F\u0440\u043E\u0441 \u043F\u043E\u0437\u0436\u0435.`,
          details: { method: methodPath, timeoutMs: this.timeoutMs },
          cause
        });
      }
      throw new AppError({
        code: "APP_TINVEST_NETWORK",
        userMessage: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C\u0441\u044F \u043A \u0441\u0435\u0440\u0432\u0435\u0440\u0443 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0438\u043D\u0442\u0435\u0440\u043D\u0435\u0442-\u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0437\u0430\u043F\u0440\u043E\u0441.",
        details: { method: methodPath },
        cause
      });
    }
    if (!response.ok) {
      throw await this.mapHttpError(response, methodPath);
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new AppError({
        code: "APP_TINVEST_BAD_RESPONSE",
        userMessage: "\u0421\u0435\u0440\u0432\u0435\u0440 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439 \u0432\u0435\u0440\u043D\u0443\u043B \u043E\u0442\u0432\u0435\u0442 \u0432 \u043D\u0435\u043E\u0436\u0438\u0434\u0430\u043D\u043D\u043E\u043C \u0444\u043E\u0440\u043C\u0430\u0442\u0435 (\u043D\u0435 JSON). \u0412\u043E\u0437\u043C\u043E\u0436\u0435\u043D \u043F\u0435\u0440\u0435\u0445\u0432\u0430\u0442 \u0442\u0440\u0430\u0444\u0438\u043A\u0430 \u043F\u0440\u043E\u043A\u0441\u0438 \u0438\u043B\u0438 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0439 \u0441\u0431\u043E\u0439 \u0448\u043B\u044E\u0437\u0430 \u2014 \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0437\u0430\u043F\u0440\u043E\u0441 \u043F\u043E\u0437\u0436\u0435.",
        details: { method: methodPath, status: response.status },
        cause
      });
    }
  }
  getAccounts() {
    return this.call("UsersService/GetAccounts", { status: "ACCOUNT_STATUS_UNSPECIFIED" });
  }
  getPortfolio(accountId) {
    return this.call("OperationsService/GetPortfolio", { accountId, currency: "RUB" });
  }
  findInstrument(query) {
    return this.call("InstrumentsService/FindInstrument", { query });
  }
  getLastPrices(instrumentIds) {
    return this.call("MarketDataService/GetLastPrices", { instrumentId: instrumentIds });
  }
  getInstrumentByUid(uid) {
    return this.call("InstrumentsService/GetInstrumentBy", {
      idType: "INSTRUMENT_ID_TYPE_UID",
      classCode: "",
      id: uid
    });
  }
  getOperationsByCursor(params) {
    return this.call("OperationsService/GetOperationsByCursor", {
      ...params,
      state: "OPERATION_STATE_EXECUTED"
    });
  }
  getWithdrawLimits(accountId) {
    return this.call("OperationsService/GetWithdrawLimits", { accountId });
  }
  getBondBy(uid) {
    return this.call("InstrumentsService/BondBy", {
      idType: "INSTRUMENT_ID_TYPE_UID",
      classCode: "",
      id: uid
    });
  }
  getBondCoupons(instrumentId, from, to) {
    return this.call("InstrumentsService/GetBondCoupons", { instrumentId, from, to });
  }
  getDividends(instrumentId, from, to) {
    return this.call("InstrumentsService/GetDividends", { instrumentId, from, to });
  }
  getAssetFundamentals(assetUids) {
    return this.call("InstrumentsService/GetAssetFundamentals", { assets: assetUids });
  }
  getForecastBy(instrumentId) {
    return this.call("InstrumentsService/GetForecastBy", { instrumentId });
  }
  getCandles(params) {
    return this.call("MarketDataService/GetCandles", params);
  }
  getTradingStatus(instrumentId) {
    return this.call("MarketDataService/GetTradingStatus", { instrumentId });
  }
  getOrderBook(instrumentId, depth) {
    return this.call("MarketDataService/GetOrderBook", { instrumentId, depth });
  }
  getTechAnalysis(request) {
    return this.call("MarketDataService/GetTechAnalysis", request);
  }
  getTradingSchedules(exchange, from, to) {
    return this.call("InstrumentsService/TradingSchedules", {
      ...exchange ? { exchange } : {},
      from,
      to
    });
  }
  getLastTrades(instrumentId, from, to) {
    return this.call("MarketDataService/GetLastTrades", { instrumentId, from, to });
  }
  getFuturesMargin(instrumentId) {
    return this.call("InstrumentsService/GetFuturesMargin", { instrumentId });
  }
  getBonds() {
    return this.call("InstrumentsService/Bonds", { instrumentStatus: "INSTRUMENT_STATUS_BASE" });
  }
  getShares() {
    return this.call("InstrumentsService/Shares", { instrumentStatus: "INSTRUMENT_STATUS_BASE" });
  }
  getEtfs() {
    return this.call("InstrumentsService/Etfs", { instrumentStatus: "INSTRUMENT_STATUS_BASE" });
  }
  getIndicatives() {
    return this.call("InstrumentsService/Indicatives", {});
  }
  getNews(params) {
    return this.call("InstrumentsService/News", params);
  }
  getInsiderDeals(instrumentId, limit) {
    return this.call("InstrumentsService/GetInsiderDeals", { instrumentId, limit });
  }
  getAssetReports(instrumentId, from, to) {
    return this.call("InstrumentsService/GetAssetReports", { instrumentId, from, to });
  }
  getStrategies() {
    return this.call("SignalService/GetStrategies", {});
  }
  getSignals(params) {
    const { limit, ...rest } = params;
    return this.call("SignalService/GetSignals", { ...rest, paging: { limit } });
  }
  getFavorites() {
    return this.call("InstrumentsService/GetFavorites", {});
  }
  openSandboxAccount() {
    return this.call("SandboxService/OpenSandboxAccount", {});
  }
  getSandboxAccounts() {
    return this.call("SandboxService/GetSandboxAccounts", {});
  }
  closeSandboxAccount(accountId) {
    return this.call("SandboxService/CloseSandboxAccount", { accountId });
  }
  sandboxPayIn(accountId, amountRub) {
    return this.call("SandboxService/SandboxPayIn", {
      accountId,
      amount: { currency: "rub", units: String(amountRub), nano: 0 }
    });
  }
  async mapHttpError(response, methodPath) {
    let apiMessage;
    let apiCode;
    try {
      const parsed = await response.json();
      apiMessage = parsed.message;
      apiCode = parsed.code;
    } catch {
      apiMessage = void 0;
    }
    const details = { status: response.status, method: methodPath, apiCode, apiMessage };
    const reason = apiMessage ? ` \u041F\u0440\u0438\u0447\u0438\u043D\u0430 \u043E\u0442 \u0441\u0435\u0440\u0432\u0435\u0440\u0430: ${apiMessage}.` : "";
    if (response.status === 401) {
      return new AppError({
        code: "APP_TINVEST_UNAUTHORIZED",
        userMessage: "\u0421\u0435\u0440\u0432\u0435\u0440 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439 \u043D\u0435 \u043F\u0440\u0438\u043D\u044F\u043B \u0442\u043E\u043A\u0435\u043D. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 T_INVEST_TOKEN \u0438\u043B\u0438 \u0432\u044B\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u043D\u043E\u0432\u044B\u0439 \u0442\u043E\u043A\u0435\u043D \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439.",
        details
      });
    }
    if (response.status === 403) {
      return new AppError({
        code: "APP_TINVEST_FORBIDDEN",
        userMessage: "\u0423 \u0442\u043E\u043A\u0435\u043D\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u043F\u0440\u0430\u0432 \u0434\u043B\u044F \u044D\u0442\u043E\u0439 \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0438. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0443\u0440\u043E\u0432\u0435\u043D\u044C \u0434\u043E\u0441\u0442\u0443\u043F\u0430 \u0442\u043E\u043A\u0435\u043D\u0430 \u0432 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430\u0445 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439.",
        details
      });
    }
    if (response.status === 404) {
      return new AppError({
        code: "APP_TINVEST_NOT_FOUND",
        userMessage: `\u0417\u0430\u043F\u0440\u043E\u0448\u0435\u043D\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u044B \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B \u043A\u043E\u043C\u0430\u043D\u0434\u044B.${reason}`,
        details
      });
    }
    if (response.status === 429) {
      return new AppError({
        code: "APP_TINVEST_RATE_LIMIT",
        userMessage: "\u041F\u0440\u0435\u0432\u044B\u0448\u0435\u043D \u043B\u0438\u043C\u0438\u0442 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432 \u043A T-Invest API. \u041F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435 \u043C\u0438\u043D\u0443\u0442\u0443 \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435.",
        details
      });
    }
    if (response.status >= 500) {
      return new AppError({
        code: "APP_TINVEST_SERVER_ERROR",
        userMessage: "\u0421\u0435\u0440\u0432\u0435\u0440 \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0437\u0430\u043F\u0440\u043E\u0441 \u043F\u043E\u0437\u0436\u0435.",
        details
      });
    }
    return new AppError({
      code: "APP_TINVEST_REQUEST_FAILED",
      userMessage: `\u0417\u0430\u043F\u0440\u043E\u0441 \u043A \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u044F\u043C \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043B\u0441\u044F \u043E\u0448\u0438\u0431\u043A\u043E\u0439. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043F\u0430\u0440\u0430\u043C\u0435\u0442\u0440\u044B \u043A\u043E\u043C\u0430\u043D\u0434\u044B \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435.${reason}`,
      details
    });
  }
};

// src/config/session-identity.ts
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);
var SESSION_ID_ENV_VAR = "TINVEST_SESSION_ID";
var TINVEST_STATE_ROOT = import_node_path4.default.join(import_node_os2.default.homedir(), ".config", "tinvest");
var SESSIONS_DIR = import_node_path4.default.join(TINVEST_STATE_ROOT, "sessions");
var GLOBAL_STATE_PATH = import_node_path4.default.join(TINVEST_STATE_ROOT, "active-mode.json");
var MAX_SESSION_ID_LENGTH = 128;
function sanitizeSessionId(raw) {
  const sanitized = raw.trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MAX_SESSION_ID_LENGTH);
  if (sanitized === "" || /^\.+$/.test(sanitized)) {
    throw new AppError({
      code: "APP_TINVEST_SESSION_ID_INVALID",
      userMessage: `\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0435\u0441\u0441\u0438\u0438 \u0432 ${SESSION_ID_ENV_VAR}: \u043F\u043E\u0441\u043B\u0435 \u043D\u043E\u0440\u043C\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u0438 \u043D\u0435 \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C \u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u044B\u0445 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0431\u0443\u043A\u0432\u044B, \u0446\u0438\u0444\u0440\u044B, \u0442\u043E\u0447\u043A\u0443, \u0434\u0435\u0444\u0438\u0441 \u0438\u043B\u0438 \u043F\u043E\u0434\u0447\u0451\u0440\u043A\u0438\u0432\u0430\u043D\u0438\u0435.`
    });
  }
  return sanitized;
}
function activeModeStatePath(env) {
  const raw = env[SESSION_ID_ENV_VAR]?.trim();
  if (raw) {
    return import_node_path4.default.join(SESSIONS_DIR, `${sanitizeSessionId(raw)}.json`);
  }
  return GLOBAL_STATE_PATH;
}

// src/config/session.ts
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_path5 = __toESM(require("node:path"), 1);
function parseStateFile(filePath) {
  let state;
  try {
    state = JSON.parse(import_node_fs2.default.readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw new AppError({
      code: "APP_TINVEST_SESSION_CORRUPT",
      userMessage: `\u0424\u0430\u0439\u043B \u0441\u0435\u0441\u0441\u0438\u0438 \u043F\u043E\u0432\u0440\u0435\u0436\u0434\u0451\u043D: ${filePath}. \u0423\u0434\u0430\u043B\u0438\u0442\u0435 \u0435\u0433\u043E \u0438 \u0437\u0430\u043D\u043E\u0432\u043E \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0440\u0435\u0436\u0438\u043C \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 \xABsession start\xBB.`,
      cause
    });
  }
  if (!T_INVEST_MODES.includes(state?.mode)) {
    throw new AppError({
      code: "APP_TINVEST_SESSION_CORRUPT",
      userMessage: `\u0424\u0430\u0439\u043B \u0441\u0435\u0441\u0441\u0438\u0438 \u043F\u043E\u0432\u0440\u0435\u0436\u0434\u0451\u043D (\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C): ${filePath}. \u0423\u0434\u0430\u043B\u0438\u0442\u0435 \u0435\u0433\u043E \u0438 \u0437\u0430\u043D\u043E\u0432\u043E \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0440\u0435\u0436\u0438\u043C.`
    });
  }
  return state;
}
function readActiveMode(filePath) {
  if (!import_node_fs2.default.existsSync(filePath)) {
    return null;
  }
  return parseStateFile(filePath);
}
function writeActiveMode(filePath, mode, now) {
  const state = { mode, startedAt: now.toISOString() };
  import_node_fs2.default.mkdirSync(import_node_path5.default.dirname(filePath), { recursive: true });
  import_node_fs2.default.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}
`, { mode: 384 });
  return state;
}
function clearActiveMode(filePath) {
  if (!import_node_fs2.default.existsSync(filePath)) {
    return false;
  }
  import_node_fs2.default.rmSync(filePath);
  return true;
}
function resolveCommandMode(state, requestedMode) {
  if (!state) {
    throw new AppError({
      code: "APP_TINVEST_SESSION_REQUIRED",
      userMessage: "\u0420\u0435\u0436\u0438\u043C \u0440\u0430\u0431\u043E\u0442\u044B \u043D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D. \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u0444\u0438\u043A\u0441\u0438\u0440\u0443\u0439\u0442\u0435 \u0435\u0433\u043E: \xABsession start --mode readonly | sandbox | full\xBB (\u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E \u2014 readonly). \u041F\u043E\u043A\u0430 \u0440\u0435\u0436\u0438\u043C \u043D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D, \u043A\u043E\u043C\u0430\u043D\u0434\u044B \u0441 \u0434\u0430\u043D\u043D\u044B\u043C\u0438 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u044E\u0442\u0441\u044F."
    });
  }
  if (requestedMode && requestedMode !== state.mode) {
    throw new AppError({
      code: "APP_TINVEST_MODE_MISMATCH",
      userMessage: `\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u0441\u0435\u0441\u0441\u0438\u0438 \u2014 \xAB${state.mode}\xBB, \u0430 \u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u0437\u0430\u043F\u0440\u043E\u0448\u0435\u043D\u0430 \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 \xAB${requestedMode}\xBB. \u0421\u043C\u0435\u043D\u0438\u0442\u0435 \u0440\u0435\u0436\u0438\u043C \u044F\u0432\u043D\u043E: \xABsession start --mode ${requestedMode}\xBB, \u0437\u0430\u0442\u0435\u043C \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043A\u043E\u043C\u0430\u043D\u0434\u0443.`
    });
  }
  return state.mode;
}

// src/cli/runtime.ts
function bootstrapEnv() {
  if (import_node_fs3.default.existsSync(GLOBAL_ENV_PATH)) {
    import_dotenv.default.config({ path: GLOBAL_ENV_PATH, quiet: true });
  }
}
function printErrorAndExit(err) {
  if (err instanceof AppError) {
    console.error(`\u041E\u0448\u0438\u0431\u043A\u0430: ${err.userMessage} [${err.code}]`);
    if (process.env.TINVEST_DEBUG) {
      console.error("\u0414\u0435\u0442\u0430\u043B\u0438:", JSON.stringify(err.details ?? null), err.cause ?? "");
    }
  } else {
    console.error("\u041E\u0448\u0438\u0431\u043A\u0430: \u041D\u0435\u043F\u0440\u0435\u0434\u0432\u0438\u0434\u0435\u043D\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u044B. \u0417\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0435 \u0441 TINVEST_DEBUG=1 \u0434\u043B\u044F \u0434\u0435\u0442\u0430\u043B\u0435\u0439. [APP_UNEXPECTED]");
    if (process.env.TINVEST_DEBUG) {
      console.error(err);
    }
  }
  process.exit(1);
}
async function runCommand(cmd, fn) {
  try {
    const { json, mode: rawMode } = cmd.optsWithGlobals();
    const requestedMode = rawMode ? parseMode(rawMode) : void 0;
    const state = readActiveMode(activeModeStatePath(process.env));
    const mode = resolveCommandMode(state, requestedMode);
    const { token } = resolveModeAndToken(process.env, mode);
    const tradingGate = resolveTradingGate(process.env);
    if (mode === "sandbox") {
      console.error("\u0420\u0435\u0436\u0438\u043C \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u044B: \u0441\u0447\u0451\u0442 \u0438 \u0434\u0430\u043D\u043D\u044B\u0435 \u0432\u0438\u0440\u0442\u0443\u0430\u043B\u044C\u043D\u044B\u0435.");
    }
    if (mode === "full" && tradingGate.stonksMode) {
      console.error("\u26A0\uFE0F STONKS-\u0440\u0435\u0436\u0438\u043C: \u0441\u0434\u0435\u043B\u043A\u0438 \u0440\u0435\u0430\u043B\u044C\u043D\u044B\u043C\u0438 \u0434\u0435\u043D\u044C\u0433\u0430\u043C\u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u044E\u0442\u0441\u044F \u0411\u0415\u0417 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0439.");
    }
    const client = new TInvestClient({ token, baseUrl: baseUrlForMode(mode) });
    const result = await fn(client, Boolean(json), mode, tradingGate);
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    printErrorAndExit(err);
  }
}
async function runSessionCommand(cmd, fn) {
  try {
    const { json } = cmd.optsWithGlobals();
    const result = await fn(Boolean(json));
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    printErrorAndExit(err);
  }
}
function withChart(json, view, human, chart) {
  if (chart === void 0) {
    return json ? view : human;
  }
  return json ? { ...view, chart } : `${human}

${chart}`;
}
var DECIMAL_INT_RE = /^\d+$/;
var DECIMAL_NUMBER_RE = /^\d+(\.\d+)?$/;
function parsePositiveInt(raw, optionName, max) {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  const withinMax = max === void 0 || value <= max;
  if (!DECIMAL_INT_RE.test(trimmed) || !Number.isSafeInteger(value) || value <= 0 || !withinMax) {
    const range = max === void 0 ? "\u043F\u043E\u043B\u043E\u0436\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u043C \u0446\u0435\u043B\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C" : `\u0446\u0435\u043B\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C \u043E\u0442 1 \u0434\u043E ${max}`;
    throw new AppError({
      code: "APP_CLI_INVALID_ARGUMENT",
      userMessage: `\u041F\u0430\u0440\u0430\u043C\u0435\u0442\u0440 ${optionName} \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C ${range}, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E \xAB${raw}\xBB.`
    });
  }
  return value;
}
function parsePositiveNumber(raw, optionName) {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!DECIMAL_NUMBER_RE.test(trimmed) || value <= 0) {
    throw new AppError({
      code: "APP_CLI_INVALID_ARGUMENT",
      userMessage: `\u041F\u0430\u0440\u0430\u043C\u0435\u0442\u0440 ${optionName} \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043F\u043E\u043B\u043E\u0436\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E \xAB${raw}\xBB.`
    });
  }
  return value;
}

// src/cli/register-analytics.ts
function registerAnalyticsCommands(program3) {
  program3.command("performance").description("\u0440\u0435\u0430\u043B\u044C\u043D\u0430\u044F \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u0441\u0447\u0451\u0442\u0430: XIRR, \u0432\u043B\u043E\u0436\u0435\u043D\u043E/\u0432\u044B\u0432\u0435\u0434\u0435\u043D\u043E, \u0434\u0438\u0432\u0438\u0434\u0435\u043D\u0434\u044B, \u043A\u043E\u043C\u0438\u0441\u0441\u0438\u0438").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430 (\u0441\u043C. tinvest accounts)").action(
    async (opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchPerformance(client, {
        explicitAccountId: opts.account,
        now: /* @__PURE__ */ new Date()
      });
      return json ? view : renderPerformance(view);
    })
  );
  program3.command("allocation").description("\u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430 \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044F: \u043A\u043B\u0430\u0441\u0441\u044B \u0430\u043A\u0442\u0438\u0432\u043E\u0432, \u0441\u0435\u043A\u0442\u043E\u0440\u044B, \u0432\u0430\u043B\u044E\u0442\u044B, \u0441\u0442\u0440\u0430\u043D\u044B, \u043A\u043E\u043D\u0446\u0435\u043D\u0442\u0440\u0430\u0446\u0438\u044F").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430 (\u0441\u043C. tinvest accounts)").option("--chart", "\u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C ASCII-\u0433\u0440\u0430\u0444\u0438\u043A \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u044B (\u0431\u0430\u0440\u044B \u043F\u043E \u0441\u0435\u043A\u0442\u043E\u0440\u0430\u043C \u0438 \u043A\u043B\u0430\u0441\u0441\u0430\u043C \u0430\u043A\u0442\u0438\u0432\u043E\u0432)").action(
    async (opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      const view = await fetchAllocation(client, {
        explicitAccountId: opts.account,
        mode,
        now: /* @__PURE__ */ new Date()
      });
      return withChart(json, view, renderAllocation(view), opts.chart ? renderAllocationChart(view) : void 0);
    })
  );
  program3.command("cash").description("\u0441\u0432\u043E\u0431\u043E\u0434\u043D\u044B\u0435 \u0434\u0435\u043D\u044C\u0433\u0438 \u043D\u0430 \u0441\u0447\u0451\u0442\u0435: \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0439 \u043E\u0441\u0442\u0430\u0442\u043E\u043A \u0438 \u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u043A\u0438").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430 (\u0441\u043C. tinvest accounts)").action(
    async (opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchCash(client, opts.account);
      return json ? view : renderCash(view);
    })
  );
  program3.command("income").description("\u043A\u0430\u043B\u0435\u043D\u0434\u0430\u0440\u044C \u043F\u0430\u0441\u0441\u0438\u0432\u043D\u043E\u0433\u043E \u0434\u043E\u0445\u043E\u0434\u0430: \u0431\u0443\u0434\u0443\u0449\u0438\u0435 \u043A\u0443\u043F\u043E\u043D\u044B \u0438 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u043D\u044B\u0435 \u0434\u0438\u0432\u0438\u0434\u0435\u043D\u0434\u044B \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044F").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430 (\u0441\u043C. tinvest accounts)").option("--chart", "\u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C ASCII-\u0433\u0440\u0430\u0444\u0438\u043A \u0434\u043E\u0445\u043E\u0434\u0430 \u043F\u043E \u043C\u0435\u0441\u044F\u0446\u0430\u043C (\u0431\u0430\u0440\u044B)").action(
    async (opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchIncome(client, { explicitAccountId: opts.account, now: /* @__PURE__ */ new Date() });
      return withChart(json, view, renderIncome(view), opts.chart ? renderIncomeChart(view) : void 0);
    })
  );
}

// src/commands/accounts.ts
var ACCOUNT_TYPE_LABELS = {
  ACCOUNT_TYPE_TINKOFF: "\u0411\u0440\u043E\u043A\u0435\u0440\u0441\u043A\u0438\u0439 \u0441\u0447\u0451\u0442",
  ACCOUNT_TYPE_TINKOFF_IIS: "\u0418\u0418\u0421",
  ACCOUNT_TYPE_INVEST_BOX: "\u0418\u043D\u0432\u0435\u0441\u0442\u043A\u043E\u043F\u0438\u043B\u043A\u0430",
  ACCOUNT_TYPE_INVEST_FUND: "\u0424\u043E\u043D\u0434"
};
var ACCOUNT_STATUS_LABELS = {
  ACCOUNT_STATUS_OPEN: "\u043E\u0442\u043A\u0440\u044B\u0442",
  ACCOUNT_STATUS_CLOSED: "\u0437\u0430\u043A\u0440\u044B\u0442",
  ACCOUNT_STATUS_NEW: "\u043E\u0442\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F"
};
var ACCESS_LEVEL_LABELS = {
  ACCOUNT_ACCESS_LEVEL_FULL_ACCESS: "\u043F\u043E\u043B\u043D\u044B\u0439 \u0434\u043E\u0441\u0442\u0443\u043F",
  ACCOUNT_ACCESS_LEVEL_READ_ONLY: "\u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u0435\u043D\u0438\u0435",
  ACCOUNT_ACCESS_LEVEL_NO_ACCESS: "\u043D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u0430"
};
function buildAccountViews(resp) {
  return resp.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    typeText: ACCOUNT_TYPE_LABELS[a.type] ?? a.type,
    statusText: ACCOUNT_STATUS_LABELS[a.status] ?? a.status,
    accessText: ACCESS_LEVEL_LABELS[a.accessLevel] ?? a.accessLevel,
    openedDate: a.openedDate ? a.openedDate.slice(0, 10) : null
  }));
}
async function fetchAccounts(api) {
  return buildAccountViews(await api.getAccounts());
}
function renderAccounts(views) {
  return renderTable(
    ["ID", "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435", "\u0422\u0438\u043F", "\u0421\u0442\u0430\u0442\u0443\u0441", "\u0414\u043E\u0441\u0442\u0443\u043F \u0442\u043E\u043A\u0435\u043D\u0430", "\u041E\u0442\u043A\u0440\u044B\u0442"],
    views.map((v) => [v.id, v.name, v.typeText, v.statusText, v.accessText, v.openedDate ?? DASH])
  );
}

// src/commands/resolve-instrument.ts
var PRIMARY_BOARD_PRIORITY = ["TQBR", "TQCB", "TQOB", "TQTF"];
async function resolveInstrument(api, query, options = {}) {
  const { instruments } = await api.findInstrument(query);
  const normalized = query.trim().toUpperCase();
  const exact = instruments.filter(
    (i) => i.ticker.toUpperCase() === normalized || (i.isin ?? "").toUpperCase() === normalized
  );
  if (exact.length === 0) {
    throw new AppError({
      code: "APP_TINVEST_INSTRUMENT_NOT_FOUND",
      userMessage: `\u0418\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442 \xAB${query}\xBB \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D \u043F\u043E \u0442\u043E\u0447\u043D\u043E\u043C\u0443 \u0442\u0438\u043A\u0435\u0440\u0443 \u0438\u043B\u0438 ISIN. \u041D\u0430\u0439\u0434\u0438\u0442\u0435 \u0442\u043E\u0447\u043D\u044B\u0439 \u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0447\u0435\u0440\u0435\u0437: tinvest search "${query}".`
    });
  }
  const typed = options.instrumentType ? exact.filter((i) => i.instrumentType === options.instrumentType) : exact;
  if (typed.length === 0) {
    const foundTypes = [...new Set(exact.map((i) => i.instrumentType))].join(", ");
    throw new AppError({
      code: "APP_TINVEST_WRONG_INSTRUMENT_TYPE",
      userMessage: `\xAB${query}\xBB \u043D\u0430\u0439\u0434\u0435\u043D, \u043D\u043E \u044D\u0442\u043E \u043D\u0435 \u043F\u043E\u0434\u0445\u043E\u0434\u044F\u0449\u0438\u0439 \u0442\u0438\u043F \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430 \u0434\u043B\u044F \u044D\u0442\u043E\u0439 \u043A\u043E\u043C\u0430\u043D\u0434\u044B (\u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F ${options.instrumentType}, \u043D\u0430\u0439\u0434\u0435\u043D\u043E: ${foundTypes}).`
    });
  }
  if (options.requireUnambiguous) {
    const distinct = new Map(typed.map((i) => [i.isin || i.uid, i]));
    if (distinct.size > 1) {
      const variants = [...distinct.values()].map((i) => `${i.ticker}/${i.classCode}/${i.isin ?? "\u2014"}`).join("; ");
      throw new AppError({
        code: "APP_TINVEST_INSTRUMENT_AMBIGUOUS",
        userMessage: `\xAB${query}\xBB \u0441\u043E\u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0443\u0435\u0442 \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u0438\u043C \u0440\u0430\u0437\u043D\u044B\u043C \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430\u043C (${variants}). \u0423\u0442\u043E\u0447\u043D\u0438\u0442\u0435 \u0437\u0430\u043F\u0440\u043E\u0441 \u043F\u043E ISIN, \u0447\u0442\u043E\u0431\u044B \u043E\u0434\u043D\u043E\u0437\u043D\u0430\u0447\u043D\u043E \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u043D\u0443\u0436\u043D\u044B\u0439 \u0432\u044B\u043F\u0443\u0441\u043A.`
      });
    }
  }
  for (const board of PRIMARY_BOARD_PRIORITY) {
    const match = typed.find((i) => i.classCode === board);
    if (match) {
      return match;
    }
  }
  return typed[0];
}
async function resolveLabelByFigi(api, figi) {
  if (!figi) {
    return null;
  }
  const { instruments } = await api.findInstrument(figi);
  const match = instruments.find((i) => i.figi === figi);
  return match ? { uid: match.uid, ticker: match.ticker, name: match.name, instrumentType: match.instrumentType } : null;
}
async function resolveMarketInstrument(api, query, options = {}) {
  try {
    const instrument = await resolveInstrument(api, query, options);
    return {
      uid: instrument.uid,
      ticker: instrument.ticker,
      name: instrument.name,
      kind: "instrument",
      figi: instrument.figi,
      classCode: instrument.classCode,
      instrumentType: instrument.instrumentType,
      currency: instrument.currency ?? null,
      lot: instrument.lot ?? null
    };
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "APP_TINVEST_INSTRUMENT_NOT_FOUND") {
      throw err;
    }
    const { instruments } = await api.getIndicatives();
    const normalized = query.trim().toUpperCase();
    const match = instruments.find((i) => i.ticker.toUpperCase() === normalized);
    if (!match) {
      throw err;
    }
    return {
      uid: match.uid,
      ticker: match.ticker,
      name: match.name,
      kind: "indicative",
      figi: match.figi ?? null,
      classCode: match.classCode ?? null,
      instrumentType: match.instrumentKind ?? null,
      currency: match.currency ?? null,
      lot: null
      // у индикативов лота нет — торговля недоступна
    };
  }
}

// src/commands/bond.ts
var ANNUAL_COUPON_WINDOW_DAYS = 366;
var COUPON_LOOKBACK_DAYS = 366;
var COUPON_HORIZON_YEARS = 30;
function toCouponView(coupon) {
  return { date: coupon.couponDate, amount: couponAmount(coupon), type: coupon.couponType ?? null };
}
function estimateAnnualCoupon(future, lastKnown, quantityPerYear, now) {
  const windowEnd = now.getTime() + ANNUAL_COUPON_WINDOW_DAYS * MS_PER_DAY;
  const withinYear = future.filter((c) => new Date(c.couponDate).getTime() <= windowEnd);
  if (withinYear.length > 0 && withinYear.every((c) => couponAmount(c) !== null)) {
    return withinYear.reduce((sum, c) => sum + (couponAmount(c) ?? 0), 0);
  }
  const reference = future.findLast((c) => couponAmount(c) !== null) ?? lastKnown;
  const referenceAmount = reference ? couponAmount(reference) : null;
  if (referenceAmount !== null && quantityPerYear !== null && quantityPerYear > 0) {
    return referenceAmount * quantityPerYear;
  }
  return null;
}
async function fetchBond(api, query, now) {
  const resolved = await resolveInstrument(api, query, { instrumentType: "bond" });
  const [{ instrument: bond }, pricesResponse] = await Promise.all([
    api.getBondBy(resolved.uid),
    api.getLastPrices([resolved.uid])
  ]);
  const couponsFrom = new Date(now.getTime() - COUPON_LOOKBACK_DAYS * MS_PER_DAY);
  const couponsTo = bond.maturityDate ? new Date(new Date(bond.maturityDate).getTime() + MS_PER_DAY) : new Date(now.getTime() + COUPON_HORIZON_YEARS * MS_PER_YEAR);
  const couponsResponse = await api.getBondCoupons(
    resolved.uid,
    couponsFrom.toISOString(),
    couponsTo.toISOString()
  );
  const warnings = [];
  const nominal = bond.nominal ? moneyToNumber(bond.nominal) : null;
  const nkd = bond.aciValue ? moneyToNumber(bond.aciValue) : 0;
  const lastPrice = pricesResponse.lastPrices.find((p) => p.instrumentUid === resolved.uid);
  const pricePercent = lastPrice?.price ? quotationToNumber(lastPrice.price) : null;
  if (pricePercent === null) {
    warnings.push("\u041D\u0435\u0442 \u0442\u0435\u043A\u0443\u0449\u0435\u0439 \u043A\u043E\u0442\u0438\u0440\u043E\u0432\u043A\u0438 \u2014 \u0442\u043E\u0440\u0433\u0438 \u043F\u043E \u0432\u044B\u043F\u0443\u0441\u043A\u0443 \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435 \u0438\u0434\u0443\u0442, \u0446\u0435\u043D\u043E\u0432\u044B\u0435 \u043C\u0435\u0442\u0440\u0438\u043A\u0438 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B.");
  }
  const priceRub = pricePercent !== null && nominal !== null ? pricePercent / 100 * nominal : null;
  const dirtyPriceRub = priceRub !== null ? priceRub + nkd : null;
  const allCoupons = [...couponsResponse.events ?? []].sort(
    (a, b) => new Date(a.couponDate).getTime() - new Date(b.couponDate).getTime()
  );
  const futureCoupons = allCoupons.filter((c) => new Date(c.couponDate).getTime() > now.getTime());
  const lastKnownPast = allCoupons.findLast(
    (c) => new Date(c.couponDate).getTime() <= now.getTime() && couponAmount(c) !== null
  );
  const quantityPerYear = bond.couponQuantityPerYear ?? null;
  const annualCouponRub = estimateAnnualCoupon(futureCoupons, lastKnownPast, quantityPerYear, now);
  const currentCouponYieldPercent = priceRub !== null ? computeCurrentCouponYieldPercent(annualCouponRub, priceRub) : null;
  const floatingCoupon = Boolean(bond.floatingCouponFlag);
  const amortization = Boolean(bond.amortizationFlag);
  const perpetual = Boolean(bond.perpetualFlag);
  const subordinated = Boolean(bond.subordinatedFlag);
  if (floatingCoupon) {
    warnings.push(
      "\u041A\u0443\u043F\u043E\u043D \u043F\u043B\u0430\u0432\u0430\u044E\u0449\u0438\u0439: \u0440\u0430\u0437\u043C\u0435\u0440 \u0431\u0443\u0434\u0443\u0449\u0438\u0445 \u0432\u044B\u043F\u043B\u0430\u0442 \u0437\u0430\u0432\u0438\u0441\u0438\u0442 \u043E\u0442 \u043A\u043B\u044E\u0447\u0435\u0432\u043E\u0439 \u0441\u0442\u0430\u0432\u043A\u0438, \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043A \u043F\u043E\u0433\u0430\u0448\u0435\u043D\u0438\u044E \u043D\u0435 \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F."
    );
  }
  if (amortization) {
    warnings.push("\u041D\u043E\u043C\u0438\u043D\u0430\u043B \u0433\u0430\u0441\u0438\u0442\u0441\u044F \u0447\u0430\u0441\u0442\u044F\u043C\u0438 (\u0430\u043C\u043E\u0440\u0442\u0438\u0437\u0430\u0446\u0438\u044F) \u2014 \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043A \u043F\u043E\u0433\u0430\u0448\u0435\u043D\u0438\u044E \u043D\u0435 \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F.");
  }
  if (perpetual) {
    warnings.push("\u0411\u0435\u0441\u0441\u0440\u043E\u0447\u043D\u0430\u044F \u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u044F: \u043D\u043E\u043C\u0438\u043D\u0430\u043B \u043D\u0435 \u043F\u043E\u0433\u0430\u0448\u0430\u0435\u0442\u0441\u044F, \u043C\u0435\u0442\u0440\u0438\u043A\u0430 \xAB\u043A \u043F\u043E\u0433\u0430\u0448\u0435\u043D\u0438\u044E\xBB \u043D\u0435\u043F\u0440\u0438\u043C\u0435\u043D\u0438\u043C\u0430.");
  }
  if (subordinated) {
    warnings.push("\u0421\u0443\u0431\u043E\u0440\u0434\u0438\u043D\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u0432\u044B\u043F\u0443\u0441\u043A: \u043F\u043E\u0432\u044B\u0448\u0435\u043D\u043D\u044B\u0439 \u0440\u0438\u0441\u043A \u0441\u043F\u0438\u0441\u0430\u043D\u0438\u044F \u043F\u0440\u0438 \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u0430\u0445 \u044D\u043C\u0438\u0442\u0435\u043D\u0442\u0430.");
  }
  if (bond.forQualInvestorFlag) {
    warnings.push("\u0412\u044B\u043F\u0443\u0441\u043A \u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0442\u043E\u043B\u044C\u043A\u043E \u043A\u0432\u0430\u043B\u0438\u0444\u0438\u0446\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u043C \u0438\u043D\u0432\u0435\u0441\u0442\u043E\u0440\u0430\u043C.");
  }
  if (bond.riskLevel === "RISK_LEVEL_HIGH") {
    warnings.push("\u0411\u0438\u0440\u0436\u0430 \u043E\u0442\u043D\u043E\u0441\u0438\u0442 \u0432\u044B\u043F\u0443\u0441\u043A \u043A \u0432\u044B\u0441\u043E\u043A\u043E\u043C\u0443 \u0443\u0440\u043E\u0432\u043D\u044E \u0440\u0438\u0441\u043A\u0430.");
  }
  const hasFutureCoupons = futureCoupons.length > 0;
  const allFutureKnown = hasFutureCoupons && futureCoupons.every((c) => couponAmount(c) !== null);
  const isDiscountBond = !hasFutureCoupons;
  const canComputeYtm = !floatingCoupon && !amortization && !perpetual && dirtyPriceRub !== null && nominal !== null && Boolean(bond.maturityDate);
  let ytmPercent = null;
  let macaulayDurationYears = null;
  if (canComputeYtm && (allFutureKnown || isDiscountBond)) {
    const flows = futureCoupons.map((c) => ({
      date: new Date(c.couponDate),
      amount: couponAmount(c) ?? 0
    }));
    flows.push({ date: new Date(bond.maturityDate), amount: nominal });
    ytmPercent = computeEffectiveYtmPercent(flows, dirtyPriceRub, now);
    if (ytmPercent !== null) {
      macaulayDurationYears = computeMacaulayDurationYears(flows, ytmPercent, now);
    }
  } else if (canComputeYtm && hasFutureCoupons && !allFutureKnown) {
    warnings.push("\u0427\u0430\u0441\u0442\u044C \u0431\u0443\u0434\u0443\u0449\u0438\u0445 \u043A\u0443\u043F\u043E\u043D\u043E\u0432 \u0435\u0449\u0451 \u043D\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0430 \u044D\u043C\u0438\u0442\u0435\u043D\u0442\u043E\u043C \u2014 \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043A \u043F\u043E\u0433\u0430\u0448\u0435\u043D\u0438\u044E \u043D\u0435 \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F.");
  }
  const offerDate = bond.callDate && new Date(bond.callDate).getTime() > now.getTime() ? bond.callDate : null;
  let ytmToOfferPercent = null;
  if (offerDate) {
    warnings.push(
      `\u041F\u043E \u0432\u044B\u043F\u0443\u0441\u043A\u0443 \u0435\u0441\u0442\u044C \u043E\u0444\u0435\u0440\u0442\u0430 ${offerDate.slice(0, 10)}: \u043F\u043E\u0441\u043B\u0435 \u043D\u0435\u0451 \u044D\u043C\u0438\u0442\u0435\u043D\u0442 \u043C\u043E\u0436\u0435\u0442 \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u043A\u0443\u043F\u043E\u043D \u2014 \u043E\u0440\u0438\u0435\u043D\u0442\u0438\u0440\u0443\u0439\u0442\u0435\u0441\u044C \u043D\u0430 \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043A \u043E\u0444\u0435\u0440\u0442\u0435.`
    );
    const canComputeYtmToOffer = !floatingCoupon && !amortization && !perpetual && dirtyPriceRub !== null && nominal !== null;
    if (canComputeYtmToOffer) {
      const offerTime = new Date(offerDate).getTime();
      const couponsToOffer = futureCoupons.filter((c) => new Date(c.couponDate).getTime() <= offerTime);
      const allKnownToOffer = couponsToOffer.every((c) => couponAmount(c) !== null);
      if (allKnownToOffer) {
        const flows = couponsToOffer.map((c) => ({
          date: new Date(c.couponDate),
          amount: couponAmount(c) ?? 0
        }));
        flows.push({ date: new Date(offerDate), amount: nominal });
        ytmToOfferPercent = computeEffectiveYtmPercent(flows, dirtyPriceRub, now);
      } else {
        warnings.push("\u0427\u0430\u0441\u0442\u044C \u043A\u0443\u043F\u043E\u043D\u043E\u0432 \u0434\u043E \u043E\u0444\u0435\u0440\u0442\u044B \u0435\u0449\u0451 \u043D\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0430 \u044D\u043C\u0438\u0442\u0435\u043D\u0442\u043E\u043C \u2014 \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043A \u043E\u0444\u0435\u0440\u0442\u0435 \u043D\u0435 \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F.");
      }
    }
  }
  const maturityDate = bond.maturityDate ?? null;
  return {
    ticker: resolved.ticker,
    isin: resolved.isin ?? bond.isin ?? null,
    name: bond.name,
    currency: bond.currency,
    uid: resolved.uid,
    nominal,
    pricePercent,
    priceRub,
    nkd,
    dirtyPriceRub,
    maturityDate,
    yearsToMaturity: maturityDate ? (new Date(maturityDate).getTime() - now.getTime()) / MS_PER_YEAR : null,
    offerDate,
    couponQuantityPerYear: quantityPerYear,
    nextCoupon: futureCoupons[0] ? toCouponView(futureCoupons[0]) : null,
    annualCouponRub,
    currentCouponYieldPercent,
    ytmPercent,
    ytmToOfferPercent,
    macaulayDurationYears,
    floatingCoupon,
    amortization,
    perpetual,
    subordinated,
    replacedBond: bond.bondType === "BOND_TYPE_REPLACED",
    forQualInvestor: Boolean(bond.forQualInvestorFlag),
    riskLevel: bond.riskLevel ?? null,
    futureCoupons: futureCoupons.map(toCouponView),
    warnings
  };
}
function renderBond(view) {
  const money = (v) => v !== null ? `${moneyOrDash(v)} ${view.currency}` : DASH;
  const date = (v) => v !== null ? v.slice(0, 10) : DASH;
  const lines = [
    `${view.name} (${view.ticker}${view.isin && view.isin !== view.ticker ? `, ${view.isin}` : ""})`,
    `\u0426\u0435\u043D\u0430: ${percentOrDash(view.pricePercent)} \u043D\u043E\u043C\u0438\u043D\u0430\u043B\u0430 = ${money(view.priceRub)} + \u041D\u041A\u0414 ${money(view.nkd)}`,
    `\u041D\u043E\u043C\u0438\u043D\u0430\u043B: ${money(view.nominal)}  \u041F\u043E\u0433\u0430\u0448\u0435\u043D\u0438\u0435: ${date(view.maturityDate)}` + (view.yearsToMaturity !== null ? ` (\u0447\u0435\u0440\u0435\u0437 ${view.yearsToMaturity.toFixed(1)} \u0433.)` : ""),
    `\u041A\u0443\u043F\u043E\u043D: ${view.annualCouponRub !== null ? `${moneyOrDash(view.annualCouponRub)} ${view.currency}/\u0433\u043E\u0434` : DASH}` + (view.couponQuantityPerYear !== null ? `, \u0432\u044B\u043F\u043B\u0430\u0442 \u0432 \u0433\u043E\u0434: ${view.couponQuantityPerYear}` : ""),
    `\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u043A\u0443\u043F\u043E\u043D\u043D\u0430\u044F \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C: ${percentOrDash(view.currentCouponYieldPercent)}`,
    `\u0414\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043A \u043F\u043E\u0433\u0430\u0448\u0435\u043D\u0438\u044E (\u044D\u0444\u0444\u0435\u043A\u0442\u0438\u0432\u043D\u0430\u044F): ${percentOrDash(view.ytmPercent)}`,
    ...view.offerDate !== null ? [`\u041E\u0444\u0435\u0440\u0442\u0430: ${date(view.offerDate)}, \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043A \u043E\u0444\u0435\u0440\u0442\u0435: ${percentOrDash(view.ytmToOfferPercent)}`] : [],
    `\u0414\u044E\u0440\u0430\u0446\u0438\u044F \u041C\u0430\u043A\u043E\u043B\u0435\u044F: ${view.macaulayDurationYears !== null ? `${view.macaulayDurationYears.toFixed(2)} \u0433.` : DASH}`
  ];
  if (view.futureCoupons.length > 0) {
    lines.push("", "\u0411\u043B\u0438\u0436\u0430\u0439\u0448\u0438\u0435 \u043A\u0443\u043F\u043E\u043D\u044B:");
    lines.push(
      renderTable(
        ["\u0414\u0430\u0442\u0430", "\u0412\u044B\u043F\u043B\u0430\u0442\u0430"],
        view.futureCoupons.slice(0, 8).map((c) => [c.date.slice(0, 10), c.amount !== null ? c.amount.toFixed(2) : "\u043D\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D"])
      )
    );
  }
  if (view.warnings.length > 0) {
    lines.push("", ...view.warnings.map((w) => `\u26A0 ${w}`));
  }
  return lines.join("\n");
}

// src/commands/dividends.ts
var DIVIDENDS_LOOKBACK_YEARS = 6;
var DIVIDENDS_LOOKAHEAD_DAYS = 366;
var TTM_WINDOW_DAYS = 365;
function eventTime(item) {
  const raw = item.recordDate ?? item.paymentDate;
  return raw ? new Date(raw).getTime() : null;
}
function toPaymentView(item) {
  return {
    recordDate: item.recordDate ?? null,
    lastBuyDate: item.lastBuyDate ?? null,
    paymentDate: item.paymentDate ?? null,
    amount: item.dividendNet ? moneyToNumber(item.dividendNet) : null,
    currency: item.dividendNet?.currency ?? null,
    yieldPercent: item.yieldValue ? quotationToNumber(item.yieldValue) : null,
    regularity: item.regularity ?? null
  };
}
async function fetchDividends(api, query, now) {
  const resolved = await resolveInstrument(api, query);
  const from = new Date(now.getTime() - DIVIDENDS_LOOKBACK_YEARS * MS_PER_YEAR).toISOString();
  const to = new Date(now.getTime() + DIVIDENDS_LOOKAHEAD_DAYS * MS_PER_DAY).toISOString();
  const [dividendsResponse, pricesResponse] = await Promise.all([
    api.getDividends(resolved.uid, from, to),
    api.getLastPrices([resolved.uid])
  ]);
  const payments = (dividendsResponse.dividends ?? []).filter((d) => d.dividendType !== "Cancelled").sort((a, b) => (eventTime(b) ?? 0) - (eventTime(a) ?? 0));
  const upcoming = payments.filter((d) => (eventTime(d) ?? 0) > now.getTime());
  const history = payments.filter((d) => (eventTime(d) ?? 0) <= now.getTime());
  const warnings = [];
  const ttmWindowStart = now.getTime() - TTM_WINDOW_DAYS * MS_PER_DAY;
  const ttmItems = history.filter((d) => (eventTime(d) ?? 0) > ttmWindowStart);
  const ttmCurrencies = new Set(ttmItems.map((d) => d.dividendNet?.currency ?? "unknown"));
  const ttmComputable = ttmItems.length > 0 && ttmCurrencies.size === 1 && !ttmCurrencies.has("unknown");
  const ttmSum = ttmComputable ? ttmItems.reduce((sum, d) => sum + moneyToNumber(d.dividendNet), 0) : null;
  const ttmCurrency = ttmComputable ? [...ttmCurrencies][0] : null;
  const lastPrice = pricesResponse.lastPrices.find((p) => p.instrumentUid === resolved.uid);
  const currentPrice = lastPrice?.price ? quotationToNumber(lastPrice.price) : null;
  const priceCurrency = resolved.currency ?? null;
  const currencyMismatch = ttmCurrency !== null && priceCurrency !== null && ttmCurrency.toLowerCase() !== priceCurrency.toLowerCase();
  if (currencyMismatch) {
    warnings.push(
      `\u0414\u0438\u0432\u0438\u0434\u0435\u043D\u0434\u044B \u0432 ${ttmCurrency.toUpperCase()}, \u0446\u0435\u043D\u0430 \u0432 ${priceCurrency.toUpperCase()} \u2014 \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C TTM \u043D\u0435 \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u0430\u043D\u0430 \u0438\u0437-\u0437\u0430 \u0440\u0430\u0437\u043D\u044B\u0445 \u0432\u0430\u043B\u044E\u0442.`
    );
  }
  const ttmYieldPercent = ttmSum !== null && currentPrice !== null && currentPrice > 0 && !currencyMismatch ? ttmSum / currentPrice * 100 : null;
  return {
    ticker: resolved.ticker,
    name: resolved.name,
    currentPrice,
    currency: resolved.currency ?? null,
    ttmSum,
    ttmYieldPercent,
    upcoming: upcoming.map(toPaymentView),
    history: history.map(toPaymentView),
    warnings
  };
}
function renderDividends(view) {
  const lines = [
    `${view.name} (${view.ticker})`,
    `\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0446\u0435\u043D\u0430: ${formatOrDash(view.currentPrice)}`,
    `\u0412\u044B\u043F\u043B\u0430\u0447\u0435\u043D\u043E \u0437\u0430 12 \u043C\u0435\u0441: ${formatOrDash(view.ttmSum)}  \u0414\u0438\u0432\u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C TTM: ${percentOrDash(view.ttmYieldPercent)}`
  ];
  const row = (p) => [
    p.recordDate ? p.recordDate.slice(0, 10) : DASH,
    p.lastBuyDate ? p.lastBuyDate.slice(0, 10) : DASH,
    formatOrDash(p.amount),
    percentOrDash(p.yieldPercent)
  ];
  const headers = ["\u0420\u0435\u0435\u0441\u0442\u0440", "\u041A\u0443\u043F\u0438\u0442\u044C \u0434\u043E", "\u041D\u0430 \u0431\u0443\u043C\u0430\u0433\u0443", "\u0414\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C"];
  if (view.upcoming.length > 0) {
    lines.push("", "\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u043D\u044B\u0435 \u0432\u044B\u043F\u043B\u0430\u0442\u044B:", renderTable(headers, view.upcoming.map(row)));
  }
  if (view.history.length > 0) {
    lines.push("", "\u0418\u0441\u0442\u043E\u0440\u0438\u044F \u0432\u044B\u043F\u043B\u0430\u0442:", renderTable(headers, view.history.map(row)));
  } else {
    lines.push("", "\u0412\u044B\u043F\u043B\u0430\u0442 \u0437\u0430 \u0440\u0430\u0441\u0441\u043C\u0430\u0442\u0440\u0438\u0432\u0430\u0435\u043C\u044B\u0439 \u043F\u0435\u0440\u0438\u043E\u0434 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E.");
  }
  for (const warning of view.warnings) {
    lines.push("", `\u26A0 ${warning}`);
  }
  return lines.join("\n");
}

// src/commands/forecast.ts
var RECOMMENDATION_LABELS = {
  RECOMMENDATION_BUY: "\u043F\u043E\u043A\u0443\u043F\u0430\u0442\u044C",
  RECOMMENDATION_HOLD: "\u0434\u0435\u0440\u0436\u0430\u0442\u044C",
  RECOMMENDATION_SELL: "\u043F\u0440\u043E\u0434\u0430\u0432\u0430\u0442\u044C"
};
function labelFor(recommendation) {
  return recommendation ? RECOMMENDATION_LABELS[recommendation] ?? recommendation : null;
}
async function fetchForecast(api, query) {
  const resolved = await resolveInstrument(api, query);
  const response = await api.getForecastBy(resolved.uid);
  const targets = response.targets ?? [];
  const consensus = response.consensus;
  if (!consensus && targets.length === 0) {
    throw new AppError({
      code: "APP_TINVEST_FORECAST_UNAVAILABLE",
      userMessage: `\u041F\u043E \xAB${resolved.ticker}\xBB \u043D\u0435\u0442 \u043F\u0440\u043E\u0433\u043D\u043E\u0437\u043E\u0432 \u0430\u043D\u0430\u043B\u0438\u0442\u0438\u043A\u043E\u0432 \u2014 \u043E\u0431\u044B\u0447\u043D\u043E \u043E\u043D\u0438 \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u044E\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0434\u043B\u044F \u043B\u0438\u043A\u0432\u0438\u0434\u043D\u044B\u0445 \u0430\u043A\u0446\u0438\u0439.`
    });
  }
  return {
    ticker: resolved.ticker,
    name: resolved.name,
    consensus: consensus ? {
      recommendation: consensus.recommendation ?? null,
      recommendationLabel: labelFor(consensus.recommendation),
      currentPrice: quotationToNumberOrNull(consensus.currentPrice),
      consensusPrice: quotationToNumberOrNull(consensus.consensus),
      minTarget: quotationToNumberOrNull(consensus.minTarget),
      maxTarget: quotationToNumberOrNull(consensus.maxTarget),
      upsidePercent: quotationToNumberOrNull(consensus.priceChangeRel)
    } : null,
    targets: targets.map((t) => ({
      company: t.company,
      recommendation: t.recommendation ?? null,
      recommendationLabel: labelFor(t.recommendation),
      date: t.recommendationDate ?? null,
      targetPrice: quotationToNumberOrNull(t.targetPrice),
      upsidePercent: quotationToNumberOrNull(t.priceChangeRel)
    }))
  };
}
function renderForecast(view) {
  const lines = [`${view.name} (${view.ticker})`];
  if (view.consensus) {
    lines.push(
      `\u041A\u043E\u043D\u0441\u0435\u043D\u0441\u0443\u0441: ${view.consensus.recommendationLabel ?? DASH} \u2014 \u0446\u0435\u043B\u044C ${formatOrDash(view.consensus.consensusPrice)} (\u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D ${formatOrDash(view.consensus.minTarget)}\u2013${formatOrDash(view.consensus.maxTarget)}), \u043F\u043E\u0442\u0435\u043D\u0446\u0438\u0430\u043B ${percentOrDash(view.consensus.upsidePercent, 1)} \u043A \u0446\u0435\u043D\u0435 ${formatOrDash(view.consensus.currentPrice)}`
    );
  }
  if (view.targets.length > 0) {
    lines.push(
      "",
      renderTable(
        ["\u0410\u043D\u0430\u043B\u0438\u0442\u0438\u043A", "\u0420\u0435\u043A\u043E\u043C\u0435\u043D\u0434\u0430\u0446\u0438\u044F", "\u0426\u0435\u043B\u044C", "\u041F\u043E\u0442\u0435\u043D\u0446\u0438\u0430\u043B", "\u0414\u0430\u0442\u0430"],
        view.targets.map((t) => [
          t.company,
          t.recommendationLabel ?? DASH,
          formatOrDash(t.targetPrice),
          percentOrDash(t.upsidePercent, 1),
          t.date ? t.date.slice(0, 10) : DASH
        ])
      )
    );
  }
  return lines.join("\n");
}

// src/commands/fundamentals.ts
function metricOrNull(value) {
  return value !== void 0 && value !== 0 ? value : null;
}
async function fetchFundamentals(api, query) {
  const resolved = await resolveInstrument(api, query);
  const { instrument } = await api.getInstrumentByUid(resolved.uid);
  if (!instrument.assetUid) {
    throw new AppError({
      code: "APP_TINVEST_FUNDAMENTALS_UNAVAILABLE",
      userMessage: `\u041F\u043E \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0443 \xAB${resolved.ticker}\xBB \u0444\u0443\u043D\u0434\u0430\u043C\u0435\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u0438 \u043D\u0435 \u043F\u0440\u0435\u0434\u043E\u0441\u0442\u0430\u0432\u043B\u044F\u044E\u0442\u0441\u044F (\u043E\u0431\u044B\u0447\u043D\u043E \u043E\u043D\u0438 \u0435\u0441\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0443 \u0430\u043A\u0446\u0438\u0439).`
    });
  }
  const response = await api.getAssetFundamentals([instrument.assetUid]);
  const item = (response.fundamentals ?? [])[0];
  if (!item) {
    throw new AppError({
      code: "APP_TINVEST_FUNDAMENTALS_UNAVAILABLE",
      userMessage: `T-Invest API \u043D\u0435 \u0432\u0435\u0440\u043D\u0443\u043B \u0444\u0443\u043D\u0434\u0430\u043C\u0435\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u0438 \u0434\u043B\u044F \xAB${resolved.ticker}\xBB \u2014 \u043F\u043E \u044D\u0442\u043E\u043C\u0443 \u0430\u043A\u0442\u0438\u0432\u0443 \u0438\u0445 \u043D\u0435\u0442.`
    });
  }
  return {
    ticker: resolved.ticker,
    name: resolved.name,
    currency: item.currency ?? null,
    valuation: {
      marketCapitalization: metricOrNull(item.marketCapitalization),
      peRatioTtm: metricOrNull(item.peRatioTtm),
      priceToBookTtm: metricOrNull(item.priceToBookTtm),
      priceToSalesTtm: metricOrNull(item.priceToSalesTtm),
      evToEbitdaMrq: metricOrNull(item.evToEbitdaMrq)
    },
    profitability: {
      roe: metricOrNull(item.roe),
      roa: metricOrNull(item.roa),
      roic: metricOrNull(item.roic),
      netMarginMrq: metricOrNull(item.netMarginMrq),
      epsTtm: metricOrNull(item.epsTtm)
    },
    dividends: {
      dividendYieldDailyTtm: metricOrNull(item.dividendYieldDailyTtm),
      forwardAnnualDividendYield: metricOrNull(item.forwardAnnualDividendYield),
      fiveYearsAverageDividendYield: metricOrNull(item.fiveYearsAverageDividendYield),
      dividendPayoutRatioFy: metricOrNull(item.dividendPayoutRatioFy),
      dividendsPerShare: metricOrNull(item.dividendsPerShare)
    },
    debt: {
      totalDebtToEbitdaMrq: metricOrNull(item.totalDebtToEbitdaMrq),
      netDebtToEbitda: metricOrNull(item.netDebtToEbitda),
      currentRatioMrq: metricOrNull(item.currentRatioMrq)
    },
    growth: {
      oneYearAnnualRevenueGrowthRate: metricOrNull(item.oneYearAnnualRevenueGrowthRate),
      threeYearAnnualRevenueGrowthRate: metricOrNull(item.threeYearAnnualRevenueGrowthRate),
      fiveYearAnnualRevenueGrowthRate: metricOrNull(item.fiveYearAnnualRevenueGrowthRate),
      epsChangeFiveYears: metricOrNull(item.epsChangeFiveYears)
    },
    trading: {
      highPriceLast52Weeks: metricOrNull(item.highPriceLast52Weeks),
      lowPriceLast52Weeks: metricOrNull(item.lowPriceLast52Weeks),
      beta: metricOrNull(item.beta),
      freeFloat: metricOrNull(item.freeFloat)
    }
  };
}
function renderFundamentals(view) {
  const cap = view.valuation.marketCapitalization !== null ? `${(view.valuation.marketCapitalization / 1e9).toFixed(1)} \u043C\u043B\u0440\u0434` : DASH;
  return [
    `${view.name} (${view.ticker})${view.currency ? `, \u0432\u0430\u043B\u044E\u0442\u0430: ${view.currency}` : ""}`,
    "",
    "\u041E\u0446\u0435\u043D\u043A\u0430:",
    `  \u041A\u0430\u043F\u0438\u0442\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u044F: ${cap}  P/E: ${formatOrDash(view.valuation.peRatioTtm)}  P/B: ${formatOrDash(view.valuation.priceToBookTtm)}  P/S: ${formatOrDash(view.valuation.priceToSalesTtm)}  EV/EBITDA: ${formatOrDash(view.valuation.evToEbitdaMrq)}`,
    "\u0420\u0435\u043D\u0442\u0430\u0431\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C:",
    `  ROE: ${percentOrDash(view.profitability.roe)}  ROA: ${percentOrDash(view.profitability.roa)}  \u041C\u0430\u0440\u0436\u0430 \u0447\u0438\u0441\u0442\u043E\u0439 \u043F\u0440\u0438\u0431\u044B\u043B\u0438: ${percentOrDash(view.profitability.netMarginMrq)}  EPS: ${formatOrDash(view.profitability.epsTtm)}`,
    "\u0414\u0438\u0432\u0438\u0434\u0435\u043D\u0434\u044B:",
    `  \u0414\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C TTM: ${percentOrDash(view.dividends.dividendYieldDailyTtm)}  \u0424\u043E\u0440\u0432\u0430\u0440\u0434\u043D\u0430\u044F: ${percentOrDash(view.dividends.forwardAnnualDividendYield)}  \u0421\u0440\u0435\u0434\u043D\u044F\u044F \u0437\u0430 5 \u043B\u0435\u0442: ${percentOrDash(view.dividends.fiveYearsAverageDividendYield)}  Payout: ${percentOrDash(view.dividends.dividendPayoutRatioFy)}`,
    "\u0414\u043E\u043B\u0433 \u0438 \u043B\u0438\u043A\u0432\u0438\u0434\u043D\u043E\u0441\u0442\u044C:",
    `  \u0414\u043E\u043B\u0433/EBITDA: ${formatOrDash(view.debt.totalDebtToEbitdaMrq)}  \u0427\u0438\u0441\u0442\u044B\u0439 \u0434\u043E\u043B\u0433/EBITDA: ${formatOrDash(view.debt.netDebtToEbitda)}  Current ratio: ${formatOrDash(view.debt.currentRatioMrq)}`,
    "\u0420\u043E\u0441\u0442:",
    `  \u0412\u044B\u0440\u0443\u0447\u043A\u0430 1\u0433: ${percentOrDash(view.growth.oneYearAnnualRevenueGrowthRate)}  3\u0433: ${percentOrDash(view.growth.threeYearAnnualRevenueGrowthRate)}  5\u043B: ${percentOrDash(view.growth.fiveYearAnnualRevenueGrowthRate)}  EPS 5\u043B: ${percentOrDash(view.growth.epsChangeFiveYears)}`,
    "\u0422\u043E\u0440\u0433\u043E\u0432\u043B\u044F:",
    `  52 \u043D\u0435\u0434\u0435\u043B\u0438: ${formatOrDash(view.trading.lowPriceLast52Weeks)}\u2013${formatOrDash(view.trading.highPriceLast52Weeks)}  \u0411\u0435\u0442\u0430: ${formatOrDash(view.trading.beta)}  Free float: ${percentOrDash(view.trading.freeFloat)}`
  ].join("\n");
}

// src/commands/portfolio.ts
function buildPortfolioView(resp, namesByUid = /* @__PURE__ */ new Map()) {
  const positions = resp.positions.map((p) => {
    const quantity = quotationToNumber(p.quantity);
    const averagePrice = moneyToNumberOrNull(p.averagePositionPrice);
    const currentPrice = moneyToNumberOrNull(p.currentPrice);
    const pnl = averagePrice !== null && currentPrice !== null ? round((currentPrice - averagePrice) * quantity) : null;
    const pnlPercent = averagePrice !== null && averagePrice !== 0 && currentPrice !== null ? round((currentPrice / averagePrice - 1) * 100) : null;
    return {
      ticker: p.ticker ?? p.figi,
      // тикера может не быть — показываем FIGI (презентация)
      name: namesByUid.get(p.instrumentUid) ?? null,
      instrumentType: p.instrumentType,
      quantity,
      averagePrice,
      currentPrice,
      value: currentPrice !== null ? round(currentPrice * quantity) : null,
      pnl,
      pnlPercent,
      nkdPerUnit: moneyToNumberOrNull(p.currentNkd),
      dailyYield: moneyToNumberOrNull(p.dailyYield)
    };
  });
  return {
    accountId: resp.accountId,
    currency: resp.totalAmountPortfolio.currency,
    totals: {
      portfolio: moneyToNumber(resp.totalAmountPortfolio),
      shares: moneyToNumber(resp.totalAmountShares),
      bonds: moneyToNumber(resp.totalAmountBonds),
      etf: moneyToNumber(resp.totalAmountEtf),
      currencies: moneyToNumber(resp.totalAmountCurrencies)
    },
    // expectedYield — message-поле Quotation: при нулевой доходности шлюз его
    // опускает (та же ловушка, что с price/time), поэтому нормализуем в null.
    expectedYieldPercent: quotationToNumberOrNull(resp.expectedYield),
    dailyYield: moneyToNumberOrNull(resp.dailyYield),
    positions
  };
}
async function loadInstrumentNames(api, uids) {
  const unique = [...new Set(uids)];
  const throttle = { concurrency: BATCH_CONCURRENCY, minIntervalMs: BATCH_MIN_INTERVAL_MS };
  const entries = await mapWithConcurrency(
    unique,
    throttle,
    async (uid) => {
      try {
        const { instrument } = await api.getInstrumentByUid(uid);
        return [uid, instrument.name];
      } catch (err) {
        console.error(
          `\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435: \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430 ${uid}: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      }
    }
  );
  return new Map(entries.filter((e) => e !== null));
}
async function fetchPortfolio(api, explicitAccountId) {
  const accountId = await resolveAccountId(api, explicitAccountId);
  const resp = await api.getPortfolio(accountId);
  const namesByUid = await loadInstrumentNames(api, resp.positions.map((p) => p.instrumentUid));
  return buildPortfolioView(resp, namesByUid);
}
function renderPortfolio(view) {
  const header = [
    `\u0421\u0447\u0451\u0442: ${view.accountId}`,
    `\u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044F: ${formatAmount(view.totals.portfolio)} ${view.currency.toUpperCase()}`,
    `\u0414\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044F: ${view.expectedYieldPercent !== null ? `${formatSigned(view.expectedYieldPercent)} %` : DASH}`,
    view.dailyYield !== null ? `\u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435 \u0437\u0430 \u0434\u0435\u043D\u044C: ${formatSigned(view.dailyYield)}` : "",
    ""
  ].filter((line) => line !== "").join("\n");
  const table = renderTable(
    ["\u0422\u0438\u043A\u0435\u0440", "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435", "\u0422\u0438\u043F", "\u041A\u043E\u043B-\u0432\u043E", "\u0421\u0440\u0435\u0434\u043D\u044F\u044F", "\u0422\u0435\u043A\u0443\u0449\u0430\u044F", "\u0421\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C", "P/L", "P/L %"],
    view.positions.map((p) => [
      p.ticker,
      p.name !== null ? truncate(p.name, 28) : DASH,
      p.instrumentType,
      formatAmount(p.quantity, 0),
      moneyOrDash(p.averagePrice),
      moneyOrDash(p.currentPrice),
      moneyOrDash(p.value),
      // P/L — со знаком «+», поэтому formatSigned, а не moneyOrDash.
      p.pnl !== null ? formatSigned(p.pnl) : DASH,
      p.pnlPercent !== null ? `${formatSigned(p.pnlPercent)} %` : DASH
    ])
  );
  return `${header}
${table}`;
}
function hasChartableValue(position) {
  return position.value !== null && position.instrumentType !== "currency";
}
function renderPortfolioChart(view) {
  const positions = view.positions.filter(hasChartableValue).sort((a, b) => b.value - a.value);
  if (positions.length === 0) {
    return "\u0413\u0440\u0430\u0444\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: \u043D\u0435\u0442 \u043F\u043E\u0437\u0438\u0446\u0438\u0439 \u0441 \u043E\u0446\u0435\u043D\u043A\u043E\u0439 \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u0438.";
  }
  const currency = currencySymbol(view.currency);
  const items = positions.map((p) => ({
    label: p.ticker,
    value: p.value,
    note: `${formatAmount(p.value, 0)} ${currency}`
  }));
  return ["\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u043F\u043E \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u0438 (\u0432\u043A\u043B\u0430\u0434 \u0432 \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044C):", barChart(items)].join("\n");
}

// src/commands/quote.ts
async function getQuotes(api, query) {
  const instrument = await resolveMarketInstrument(api, query);
  const { lastPrices } = await api.getLastPrices([instrument.uid]);
  const lastPrice = lastPrices.find((p) => p.instrumentUid === instrument.uid);
  const price = quotationToNumberOrNull(lastPrice?.price);
  return [
    {
      ticker: instrument.ticker,
      name: instrument.name,
      classCode: instrument.classCode,
      instrumentType: instrument.instrumentType,
      uid: instrument.uid,
      figi: instrument.figi,
      currency: instrument.currency,
      lot: instrument.lot,
      price,
      time: lastPrice?.time ?? null
    }
  ];
}
function renderQuotes(views) {
  return renderTable(
    ["\u0422\u0438\u043A\u0435\u0440", "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435", "\u0426\u0435\u043D\u0430", "\u0412\u0430\u043B\u044E\u0442\u0430", "\u041B\u043E\u0442", "\u041A\u043B\u0430\u0441\u0441", "\u0412\u0440\u0435\u043C\u044F"],
    views.map((v) => [
      v.ticker,
      v.name,
      v.price !== null ? formatAmount(v.price) : DASH,
      v.currency ? v.currency.toUpperCase() : DASH,
      v.lot !== null ? String(v.lot) : DASH,
      v.classCode ?? DASH,
      v.time !== null ? formatMoscowDateTime(v.time) : DASH
    ])
  );
}

// src/commands/search.ts
async function searchInstruments(api, query) {
  const { instruments } = await api.findInstrument(query);
  return instruments.map((i) => ({
    ticker: i.ticker,
    name: i.name,
    instrumentType: i.instrumentType,
    classCode: i.classCode,
    uid: i.uid,
    figi: i.figi,
    isin: i.isin ?? null,
    currency: i.currency ?? null,
    lot: i.lot ?? null
  }));
}
var MAX_NAME_WIDTH = 60;
function renderSearchResults(views) {
  if (views.length === 0) {
    return "\u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E. \u0423\u0442\u043E\u0447\u043D\u0438\u0442\u0435 \u0437\u0430\u043F\u0440\u043E\u0441: \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438, \u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN.";
  }
  return renderTable(
    ["\u0422\u0438\u043A\u0435\u0440", "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435", "\u0422\u0438\u043F", "\u041A\u043B\u0430\u0441\u0441", "\u0412\u0430\u043B\u044E\u0442\u0430", "\u041B\u043E\u0442"],
    views.map((v) => [
      v.ticker,
      truncate(v.name, MAX_NAME_WIDTH),
      v.instrumentType,
      v.classCode,
      v.currency ? v.currency.toUpperCase() : DASH,
      v.lot !== null ? String(v.lot) : DASH
    ])
  );
}

// src/cli/register-core.ts
function registerCoreCommands(program3) {
  program3.command("accounts").description("\u0441\u043F\u0438\u0441\u043E\u043A \u0441\u0447\u0435\u0442\u043E\u0432").action(
    async (_opts, cmd) => runCommand(cmd, async (client, json) => {
      const views = await fetchAccounts(client);
      return json ? views : renderAccounts(views);
    })
  );
  program3.command("portfolio").description("\u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044C: \u043F\u043E\u0437\u0438\u0446\u0438\u0438, \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C, P/L").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430 (\u0441\u043C. tinvest accounts)").option("--chart", "\u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C ASCII-\u0433\u0440\u0430\u0444\u0438\u043A \u043F\u043E\u0437\u0438\u0446\u0438\u0439 \u043F\u043E \u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u0438 (\u0431\u0430\u0440\u044B; \u0434\u043B\u044F \u0441\u0440\u0430\u0432\u043D\u0435\u043D\u0438\u044F \u0432\u0435\u043B\u0438\u0447\u0438\u043D)").action(
    async (opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchPortfolio(client, opts.account);
      return withChart(json, view, renderPortfolio(view), opts.chart ? renderPortfolioChart(view) : void 0);
    })
  );
  program3.command("quote").description("\u043F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u0446\u0435\u043D\u0430 \u043F\u043E \u0442\u043E\u0447\u043D\u043E\u043C\u0443 \u0442\u0438\u043A\u0435\u0440\u0443 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, SBER)").argument("<ticker>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430").action(
    async (ticker, _opts, cmd) => runCommand(cmd, async (client, json) => {
      const views = await getQuotes(client, ticker);
      return json ? views : renderQuotes(views);
    })
  );
  program3.command("search").description("\u043F\u043E\u0438\u0441\u043A \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u043E\u0432 \u043F\u043E \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u044E, \u0442\u0438\u043A\u0435\u0440\u0443 \u0438\u043B\u0438 ISIN").argument("<query>", "\u043F\u043E\u0438\u0441\u043A\u043E\u0432\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441").action(
    async (query, _opts, cmd) => runCommand(cmd, async (client, json) => {
      const views = await searchInstruments(client, query);
      return json ? views : renderSearchResults(views);
    })
  );
  program3.command("operations").description("\u0438\u0441\u0442\u043E\u0440\u0438\u044F \u0438\u0441\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0445 \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0439 \u043F\u043E \u0441\u0447\u0451\u0442\u0443").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430 (\u0441\u043C. tinvest accounts)").option("-d, --days <n>", "\u043F\u0435\u0440\u0438\u043E\u0434 \u0432 \u0434\u043D\u044F\u0445 \u043E\u0442 \u0442\u0435\u043A\u0443\u0449\u0435\u0433\u043E \u043C\u043E\u043C\u0435\u043D\u0442\u0430", String(DEFAULT_OPERATIONS_DAYS)).action(
    async (opts, cmd) => runCommand(cmd, async (client, json) => {
      const result = await fetchOperations(client, {
        explicitAccountId: opts.account,
        days: parsePositiveInt(opts.days, "--days"),
        now: /* @__PURE__ */ new Date()
      });
      return json ? result : renderOperations(result);
    })
  );
  program3.command("bond").description("\u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u0438: \u043A\u0443\u043F\u043E\u043D\u044B, \u043E\u0444\u0435\u0440\u0442\u0430, \u041D\u041A\u0414, \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043A \u043F\u043E\u0433\u0430\u0448\u0435\u043D\u0438\u044E, \u0434\u044E\u0440\u0430\u0446\u0438\u044F").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u0438 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, RU000A10BPZ1)").action(
    async (query, _opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchBond(client, query, /* @__PURE__ */ new Date());
      return json ? view : renderBond(view);
    })
  );
  program3.command("dividends").description("\u0434\u0438\u0432\u0438\u0434\u0435\u043D\u0434\u044B: \u0438\u0441\u0442\u043E\u0440\u0438\u044F \u0432\u044B\u043F\u043B\u0430\u0442, \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u043D\u044B\u0435 \u0431\u0443\u0434\u0443\u0449\u0438\u0435, TTM-\u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0431\u0443\u043C\u0430\u0433\u0438 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, SBER)").action(
    async (query, _opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchDividends(client, query, /* @__PURE__ */ new Date());
      return json ? view : renderDividends(view);
    })
  );
  program3.command("fundamentals").description("\u0444\u0443\u043D\u0434\u0430\u043C\u0435\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0435 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u0438 \u044D\u043C\u0438\u0442\u0435\u043D\u0442\u0430: P/E, ROE, \u0434\u043E\u043B\u0433, \u0434\u0438\u0432\u0438\u0434\u0435\u043D\u0434\u044B, \u0440\u043E\u0441\u0442").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0430\u043A\u0446\u0438\u0438 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, SBER)").action(
    async (query, _opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchFundamentals(client, query);
      return json ? view : renderFundamentals(view);
    })
  );
  program3.command("forecast").description("\u043F\u0440\u043E\u0433\u043D\u043E\u0437\u044B \u0430\u043D\u0430\u043B\u0438\u0442\u0438\u043A\u043E\u0432: \u043A\u043E\u043D\u0441\u0435\u043D\u0441\u0443\u0441, \u0446\u0435\u043B\u0435\u0432\u044B\u0435 \u0446\u0435\u043D\u044B, \u0440\u0435\u043A\u043E\u043C\u0435\u043D\u0434\u0430\u0446\u0438\u0438").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0430\u043A\u0446\u0438\u0438 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, SBER)").action(
    async (query, _opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchForecast(client, query);
      return json ? view : renderForecast(view);
    })
  );
}

// src/commands/favorites.ts
function buildFavoriteViews(instruments, prices) {
  const priceByUid = new Map(prices.map((p) => [p.instrumentUid, p]));
  return instruments.map((instrument) => {
    const price = priceByUid.get(instrument.uid)?.price;
    return {
      uid: instrument.uid,
      ticker: instrument.ticker ?? null,
      name: instrument.name ?? null,
      instrumentType: instrument.instrumentType ?? null,
      lastPrice: quotationToNumberOrNull(price),
      apiTradeAvailable: instrument.apiTradeAvailableFlag ?? null
    };
  });
}
async function fetchFavorites(api) {
  const resp = await api.getFavorites();
  const instruments = resp.favoriteInstruments ?? [];
  if (instruments.length === 0) {
    return [];
  }
  const prices = await api.getLastPrices(instruments.map((i) => i.uid));
  return buildFavoriteViews(instruments, prices.lastPrices);
}
function renderFavorites(views) {
  if (views.length === 0) {
    return "\u0421\u043F\u0438\u0441\u043E\u043A \u0438\u0437\u0431\u0440\u0430\u043D\u043D\u043E\u0433\u043E \u043F\u0443\u0441\u0442.";
  }
  const table = renderTable(
    ["\u0422\u0438\u043A\u0435\u0440", "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435", "\u0422\u0438\u043F", "\u0426\u0435\u043D\u0430", "\u0427\u0435\u0440\u0435\u0437 API"],
    views.map((v) => [
      v.ticker ?? DASH,
      v.name ?? DASH,
      v.instrumentType ?? DASH,
      moneyOrDash(v.lastPrice),
      v.apiTradeAvailable === null ? DASH : v.apiTradeAvailable ? "\u0434\u0430" : "\u043D\u0435\u0442"
    ])
  );
  return `\u0418\u0437\u0431\u0440\u0430\u043D\u043D\u043E\u0435 (${views.length}):
${table}`;
}

// src/format/direction.ts
function orderDirectionToApi(dir) {
  return dir === "buy" ? "ORDER_DIRECTION_BUY" : "ORDER_DIRECTION_SELL";
}
function stopDirectionToApi(dir) {
  return dir === "buy" ? "STOP_ORDER_DIRECTION_BUY" : "STOP_ORDER_DIRECTION_SELL";
}
function directionFromApi(raw) {
  if (raw === "ORDER_DIRECTION_BUY" || raw === "STOP_ORDER_DIRECTION_BUY") {
    return "buy";
  }
  if (raw === "ORDER_DIRECTION_SELL" || raw === "STOP_ORDER_DIRECTION_SELL") {
    return "sell";
  }
  return null;
}
function directionLabel(dir) {
  if (dir === "buy") {
    return "\u043F\u043E\u043A\u0443\u043F\u043A\u0430";
  }
  if (dir === "sell") {
    return "\u043F\u0440\u043E\u0434\u0430\u0436\u0430";
  }
  return DASH;
}
function directionPhrase(dir) {
  return dir === "buy" ? "\u043D\u0430 \u043F\u043E\u043A\u0443\u043F\u043A\u0443" : "\u043D\u0430 \u043F\u0440\u043E\u0434\u0430\u0436\u0443";
}

// src/commands/insiders.ts
function toDirection(raw) {
  if (raw === "TRADE_DIRECTION_BUY") {
    return "buy";
  }
  if (raw === "TRADE_DIRECTION_SELL") {
    return "sell";
  }
  return null;
}
function buildInsidersView(ticker, name, deals) {
  const views = deals.map((deal) => {
    const price = quotationToNumberOrNull(deal.price);
    const quantity = deal.quantity ? Number(deal.quantity) : null;
    return {
      date: deal.date?.slice(0, 10) ?? null,
      direction: toDirection(deal.direction),
      investorName: deal.investorName ?? null,
      investorPosition: deal.investorPosition ?? null,
      quantity,
      price,
      amount: price !== null && quantity !== null ? round(price * quantity) : null,
      percentage: deal.percentage ?? null,
      disclosureDate: deal.disclosureDate?.slice(0, 10) ?? null
    };
  });
  return {
    ticker,
    name,
    deals: views,
    buyCount: views.filter((d) => d.direction === "buy").length,
    sellCount: views.filter((d) => d.direction === "sell").length
  };
}
async function fetchInsiders(api, query, limit) {
  const instrument = await resolveInstrument(api, query);
  const resp = await api.getInsiderDeals(instrument.uid, limit);
  return buildInsidersView(instrument.ticker, instrument.name, resp.insiderDeals ?? []);
}
function renderInsiders(view) {
  const header = `${view.ticker} \u2014 ${view.name}: \u0441\u0434\u0435\u043B\u043A\u0438 \u0438\u043D\u0441\u0430\u0439\u0434\u0435\u0440\u043E\u0432 (\u043F\u043E\u043A\u0443\u043F\u043E\u043A: ${view.buyCount}, \u043F\u0440\u043E\u0434\u0430\u0436: ${view.sellCount})`;
  if (view.deals.length === 0) {
    return `${header}
\u0420\u0430\u0441\u043A\u0440\u044B\u0442\u044B\u0445 \u0441\u0434\u0435\u043B\u043E\u043A \u0438\u043D\u0441\u0430\u0439\u0434\u0435\u0440\u043E\u0432 \u043D\u0435\u0442.`;
  }
  const table = renderTable(
    ["\u0414\u0430\u0442\u0430", "\u0422\u0438\u043F", "\u041A\u0442\u043E", "\u041A\u043E\u043B-\u0432\u043E", "\u0426\u0435\u043D\u0430", "\u0421\u0443\u043C\u043C\u0430"],
    view.deals.map((d) => [
      d.date ?? DASH,
      directionLabel(d.direction),
      `${d.investorName ?? DASH}${d.investorPosition ? ` (${d.investorPosition})` : ""}`,
      moneyOrDash(d.quantity, 0),
      moneyOrDash(d.price),
      moneyOrDash(d.amount, 0)
    ])
  );
  return `${header}
${table}`;
}

// src/commands/news.ts
function toNewsViews(items) {
  return items.map((item) => ({
    id: item.id,
    ts: item.ts,
    source: item.source ?? null,
    title: item.title ?? "(\u0431\u0435\u0437 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0430)",
    content: item.content ?? null,
    tickers: (item.instrumentId ?? []).map((ref) => ref.instrument?.ticker).filter((t) => Boolean(t)),
    priority: item.priority ?? false
  }));
}
function filterNewsByInstrument(items, uid, ticker) {
  const upperTicker = ticker.toUpperCase();
  return items.filter(
    (item) => (item.instrumentId ?? []).some(
      (ref) => ref.instrument?.instrumentUid === uid || ref.instrument?.ticker?.toUpperCase() === upperTicker
    )
  );
}
async function fetchNews(api, params) {
  if (!params.query) {
    const resp = await api.getNews({ limit: params.limit });
    const items = resp.items ?? [];
    return { query: null, scannedItems: items.length, items: toNewsViews(items) };
  }
  const instrument = await resolveInstrument(api, params.query);
  const matched = [];
  let cursor;
  let scannedItems = 0;
  for (let page = 0; page < NEWS_FILTER_MAX_PAGES; page += 1) {
    const resp = await api.getNews({ cursor, limit: NEWS_PAGE_LIMIT });
    const items = resp.items ?? [];
    scannedItems += items.length;
    matched.push(...filterNewsByInstrument(items, instrument.uid, instrument.ticker));
    if (matched.length >= params.limit || !resp.hasNext || !resp.nextCursor) {
      break;
    }
    cursor = resp.nextCursor;
  }
  return {
    query: instrument.ticker,
    scannedItems,
    items: toNewsViews(matched.slice(0, params.limit))
  };
}
function renderNews(view) {
  const header = view.query ? `\u041D\u043E\u0432\u043E\u0441\u0442\u0438 \u043F\u043E ${view.query} (\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u043D\u043E ${view.scannedItems} \u043D\u043E\u0432\u043E\u0441\u0442\u0435\u0439 \u043B\u0435\u043D\u0442\u044B):` : "\u041D\u043E\u0432\u043E\u0441\u0442\u0438 \u0440\u044B\u043D\u043A\u0430:";
  if (view.items.length === 0) {
    return `${header}
\u0421\u0440\u0435\u0434\u0438 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0445 ${view.scannedItems} \u043D\u043E\u0432\u043E\u0441\u0442\u0435\u0439 \u043B\u0435\u043D\u0442\u044B \u0443\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u0439 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E.`;
  }
  const lines = [header, ""];
  for (const item of view.items) {
    const tickers = item.tickers.length > 0 ? ` [${item.tickers.join(", ")}]` : "";
    lines.push(`\u2022 ${item.ts.slice(0, 16).replace("T", " ")} (${item.source ?? "\u2014"})${tickers}`);
    lines.push(`  ${item.title}`);
  }
  return lines.join("\n");
}

// src/commands/reports.ts
function periodLabel(event) {
  const year = event.periodYear ?? "";
  switch (event.periodType) {
    case "PERIOD_TYPE_QUARTER":
      return `${event.periodNum ?? "?"} \u043A\u0432\u0430\u0440\u0442\u0430\u043B ${year}`;
    case "PERIOD_TYPE_SEMIANNUAL":
      return `${event.periodNum ?? "?"} \u043F\u043E\u043B\u0443\u0433\u043E\u0434\u0438\u0435 ${year}`;
    case "PERIOD_TYPE_ANNUAL":
      return `${year} \u0433\u043E\u0434`;
    default:
      return `${event.periodType ?? "\u043F\u0435\u0440\u0438\u043E\u0434"} ${year}`;
  }
}
function buildReportsView(params) {
  const events = params.events.filter((e) => Boolean(e.reportDate)).sort((a, b) => a.reportDate.localeCompare(b.reportDate)).map((e) => ({
    reportDate: e.reportDate.slice(0, 10),
    periodLabel: periodLabel(e),
    upcoming: Date.parse(e.reportDate) > params.now.getTime()
  }));
  return { ticker: params.ticker, name: params.name, from: params.from, to: params.to, events };
}
async function fetchReports(api, query, now) {
  const instrument = await resolveInstrument(api, query);
  const from = new Date(now.getTime() - REPORTS_WINDOW_DAYS * MS_PER_DAY).toISOString();
  const to = new Date(now.getTime() + REPORTS_WINDOW_DAYS * MS_PER_DAY).toISOString();
  const resp = await api.getAssetReports(instrument.uid, from, to);
  return buildReportsView({
    ticker: instrument.ticker,
    name: instrument.name,
    from,
    to,
    events: resp.events ?? [],
    now
  });
}
function renderReports(view) {
  const header = `${view.ticker} \u2014 ${view.name}: \u043A\u0430\u043B\u0435\u043D\u0434\u0430\u0440\u044C \u043E\u0442\u0447\u0451\u0442\u043D\u043E\u0441\u0442\u0435\u0439 (${view.from.slice(0, 10)} \u2014 ${view.to.slice(0, 10)})`;
  if (view.events.length === 0) {
    return `${header}
\u0421\u043E\u0431\u044B\u0442\u0438\u0439 \u043E\u0442\u0447\u0451\u0442\u043D\u043E\u0441\u0442\u0438 \u0432 \u044D\u0442\u043E\u043C \u043E\u043A\u043D\u0435 \u043D\u0435\u0442.`;
  }
  const lines = [header, ""];
  for (const event of view.events) {
    lines.push(`\u2022 ${event.reportDate} \u2014 \u043E\u0442\u0447\u0451\u0442 \u0437\u0430 ${event.periodLabel}${event.upcoming ? " (\u043E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F)" : ""}`);
  }
  return lines.join("\n");
}

// src/commands/signals.ts
function buildSignalViews(signals, instrumentsByUid) {
  return signals.map((signal) => {
    const instrument = signal.instrumentUid ? instrumentsByUid.get(signal.instrumentUid) : void 0;
    const initialPrice = quotationToNumberOrNull(signal.initialPrice);
    const targetPrice = quotationToNumberOrNull(signal.targetPrice);
    return {
      signalId: signal.signalId,
      strategyName: signal.strategyName ?? null,
      ticker: instrument?.ticker ?? null,
      instrumentName: instrument?.name ?? null,
      instrumentUid: signal.instrumentUid ?? null,
      // Направление сигнала — собственный enum SIGNAL_DIRECTION_* (не order/stop),
      // поэтому маппинг локальный; на неизвестное значение честно null.
      direction: signal.direction === "SIGNAL_DIRECTION_BUY" ? "buy" : signal.direction === "SIGNAL_DIRECTION_SELL" ? "sell" : null,
      ideaName: signal.name ?? null,
      createdAt: signal.createDt?.slice(0, 10) ?? null,
      endsAt: signal.endDt?.slice(0, 10) ?? null,
      initialPrice,
      targetPrice,
      potentialPercent: initialPrice !== null && initialPrice !== 0 && targetPrice !== null ? round((targetPrice / initialPrice - 1) * 100) : null,
      probability: signal.probability ?? null
    };
  });
}
async function fetchSignals(api, params) {
  const instrumentUid = params.ticker ? (await resolveInstrument(api, params.ticker)).uid : void 0;
  const resp = await api.getSignals({
    strategyId: params.strategyId,
    instrumentUid,
    active: "SIGNAL_STATE_ACTIVE",
    limit: params.limit ?? SIGNALS_DEFAULT_LIMIT
  });
  const signals = resp.signals ?? [];
  if (signals.length === 0) {
    return [];
  }
  const catalogs = await Promise.all(
    ["shares", "bonds", "etfs"].map(
      (kind) => loadCatalog(api, kind, params.mode, params.now, params.cacheDir)
    )
  );
  const instrumentsByUid = /* @__PURE__ */ new Map();
  for (const catalog of catalogs) {
    for (const item of catalog.items) {
      instrumentsByUid.set(item.uid, { ticker: item.ticker, name: item.name });
    }
  }
  return buildSignalViews(signals, instrumentsByUid);
}
async function fetchStrategies(api) {
  const resp = await api.getStrategies();
  return (resp.strategies ?? []).map((s) => ({
    strategyId: s.strategyId,
    name: s.strategyName ?? null,
    type: s.strategyType === "STRATEGY_TYPE_TECHNICAL" ? "technical" : s.strategyType === "STRATEGY_TYPE_FUNDAMENTAL" ? "fundamental" : null,
    description: s.strategyDescription ?? null,
    activeSignals: s.activeSignals ?? null,
    totalSignals: s.totalSignals ?? null
  }));
}
function renderSignals(views) {
  if (views.length === 0) {
    return "\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0445 \u0441\u0438\u0433\u043D\u0430\u043B\u043E\u0432 \u043F\u043E \u0437\u0430\u0434\u0430\u043D\u043D\u044B\u043C \u0444\u0438\u043B\u044C\u0442\u0440\u0430\u043C \u043D\u0435\u0442.";
  }
  return renderTable(
    ["\u0411\u0443\u043C\u0430\u0433\u0430", "\u041D\u0430\u043F\u0440.", "\u0421\u0442\u0440\u0430\u0442\u0435\u0433\u0438\u044F", "\u0426\u0435\u043B\u044C", "\u041F\u043E\u0442\u0435\u043D\u0446\u0438\u0430\u043B", "\u0412\u0435\u0440\u043E\u044F\u0442\u043D.", "\u0414\u043E"],
    views.map((v) => [
      v.ticker ?? v.instrumentUid?.slice(0, 8) ?? DASH,
      directionLabel(v.direction),
      v.strategyName ?? DASH,
      moneyOrDash(v.targetPrice),
      // Потенциал — с суффиксом « %» через пробел, поэтому не percentOrDash.
      v.potentialPercent !== null ? `${formatAmount(v.potentialPercent, 1)} %` : DASH,
      v.probability !== null ? `${v.probability} %` : DASH,
      v.endsAt ?? DASH
    ])
  );
}
function renderStrategies(views) {
  if (views.length === 0) {
    return "\u0421\u0442\u0440\u0430\u0442\u0435\u0433\u0438\u0438 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B.";
  }
  const lines = [];
  for (const s of views) {
    lines.push(
      `\u2022 ${s.name ?? s.strategyId} [${s.type ?? DASH}] \u2014 \u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0445 \u0441\u0438\u0433\u043D\u0430\u043B\u043E\u0432: ${s.activeSignals ?? 0}`
    );
  }
  return lines.join("\n");
}

// src/cli/register-info.ts
function registerInfoCommands(program3) {
  program3.command("news").description("\u043D\u043E\u0432\u043E\u0441\u0442\u0438 \u0440\u044B\u043D\u043A\u0430 (\u0431\u0435\u0437 \u0430\u0440\u0433\u0443\u043C\u0435\u043D\u0442\u0430) \u0438\u043B\u0438 \u043F\u043E \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u043E\u0439 \u0431\u0443\u043C\u0430\u0433\u0435").argument("[query]", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0431\u0443\u043C\u0430\u0433\u0438 (\u0431\u0435\u0437 \u043D\u0435\u0433\u043E \u2014 \u043E\u0431\u0449\u0430\u044F \u043B\u0435\u043D\u0442\u0430)").option("-n, --limit <n>", "\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043D\u043E\u0432\u043E\u0441\u0442\u0435\u0439 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C", String(NEWS_DEFAULT_LIMIT)).action(
    async (query, opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchNews(client, {
        query,
        limit: parsePositiveInt(opts.limit, "--limit")
      });
      return json ? view : renderNews(view);
    })
  );
  program3.command("insiders").description("\u0441\u0434\u0435\u043B\u043A\u0438 \u0438\u043D\u0441\u0430\u0439\u0434\u0435\u0440\u043E\u0432 \u043F\u043E \u0431\u0443\u043C\u0430\u0433\u0435 (\u0440\u0430\u0441\u043A\u0440\u044B\u0442\u0438\u0435 \u044D\u043C\u0438\u0442\u0435\u043D\u0442\u0430)").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0431\u0443\u043C\u0430\u0433\u0438").option("-n, --limit <n>", "\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0441\u0434\u0435\u043B\u043E\u043A \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C", String(INSIDERS_DEFAULT_LIMIT)).action(
    async (query, opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchInsiders(client, query, parsePositiveInt(opts.limit, "--limit"));
      return json ? view : renderInsiders(view);
    })
  );
  program3.command("reports").description("\u043A\u0430\u043B\u0435\u043D\u0434\u0430\u0440\u044C \u043E\u0442\u0447\u0451\u0442\u043D\u043E\u0441\u0442\u0435\u0439 \u044D\u043C\u0438\u0442\u0435\u043D\u0442\u0430: \u043F\u0440\u043E\u0448\u0435\u0434\u0448\u0438\u0435 \u0438 \u043E\u0436\u0438\u0434\u0430\u0435\u043C\u044B\u0435 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0431\u0443\u043C\u0430\u0433\u0438").action(
    async (query, _opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchReports(client, query, /* @__PURE__ */ new Date());
      return json ? view : renderReports(view);
    })
  );
  program3.command("signals").description("\u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0435 \u0441\u0438\u0433\u043D\u0430\u043B\u044B \u0430\u043D\u0430\u043B\u0438\u0442\u0438\u0447\u0435\u0441\u043A\u0438\u0445 \u0441\u0442\u0440\u0430\u0442\u0435\u0433\u0438\u0439 (SignalService)").option("--ticker <ticker>", "\u0442\u043E\u043B\u044C\u043A\u043E \u043F\u043E \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u043E\u0439 \u0431\u0443\u043C\u0430\u0433\u0435").option("--strategy <id>", "\u0442\u043E\u043B\u044C\u043A\u043E \u043F\u043E \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u043E\u0439 \u0441\u0442\u0440\u0430\u0442\u0435\u0433\u0438\u0438").option("--strategies", "\u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0441\u043F\u0438\u0441\u043E\u043A \u0441\u0442\u0440\u0430\u0442\u0435\u0433\u0438\u0439 \u0432\u043C\u0435\u0441\u0442\u043E \u0441\u0438\u0433\u043D\u0430\u043B\u043E\u0432").action(
    async (opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      if (opts.strategies) {
        const strategies = await fetchStrategies(client);
        return json ? strategies : renderStrategies(strategies);
      }
      const views = await fetchSignals(client, {
        mode,
        now: /* @__PURE__ */ new Date(),
        ticker: opts.ticker,
        strategyId: opts.strategy
      });
      return json ? views : renderSignals(views);
    })
  );
  program3.command("favorites").description("\u0432\u043E\u0442\u0447\u043B\u0438\u0441\u0442 \u0438\u0437 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439 \u0441 \u0442\u0435\u043A\u0443\u0449\u0438\u043C\u0438 \u0446\u0435\u043D\u0430\u043C\u0438").action(
    async (_opts, cmd) => runCommand(cmd, async (client, json) => {
      const views = await fetchFavorites(client);
      return json ? views : renderFavorites(views);
    })
  );
}

// src/commands/history.ts
function pickCandleInterval(days) {
  if (days <= CANDLES_HOUR_MAX_DAYS) {
    return "CANDLE_INTERVAL_HOUR";
  }
  if (days <= CANDLES_DAY_MAX_DAYS) {
    return "CANDLE_INTERVAL_DAY";
  }
  if (days <= CANDLES_WEEK_MAX_DAYS) {
    return "CANDLE_INTERVAL_WEEK";
  }
  if (days <= CANDLES_MONTH_MAX_DAYS) {
    return "CANDLE_INTERVAL_MONTH";
  }
  throw new AppError({
    code: "APP_CLI_INVALID_ARGUMENT",
    userMessage: `\u041F\u0435\u0440\u0438\u043E\u0434 --days \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0442\u044C ${CANDLES_MONTH_MAX_DAYS} \u0434\u043D\u0435\u0439 (\u043B\u0438\u043C\u0438\u0442 \u0433\u043B\u0443\u0431\u0438\u043D\u044B \u0438\u0441\u0442\u043E\u0440\u0438\u0438).`
  });
}
function periodsPerYear(interval) {
  switch (interval) {
    case "CANDLE_INTERVAL_DAY":
      return TRADING_DAYS_PER_YEAR;
    case "CANDLE_INTERVAL_WEEK":
      return WEEKS_PER_YEAR;
    case "CANDLE_INTERVAL_MONTH":
      return MONTHS_PER_YEAR;
    default:
      return null;
  }
}
function toCandleViews(candles) {
  return candles.map((c) => ({
    time: c.time,
    open: c.open ? quotationToNumber(c.open) : null,
    high: c.high ? quotationToNumber(c.high) : null,
    low: c.low ? quotationToNumber(c.low) : null,
    close: c.close ? quotationToNumber(c.close) : null,
    volume: c.volume ? Number(c.volume) : null
  }));
}
function computeCandleStats(candles, interval) {
  const closes = candles.map((c) => c.close).filter((v) => v !== null);
  const lows = candles.map((c) => c.low).filter((v) => v !== null);
  const highs = candles.map((c) => c.high).filter((v) => v !== null);
  const volumes = candles.map((c) => c.volume).filter((v) => v !== null);
  const firstClose = closes.length > 0 ? closes[0] : null;
  const lastClose = closes.length > 0 ? closes[closes.length - 1] : null;
  const minLow = lows.length > 0 ? Math.min(...lows) : null;
  const maxHigh = highs.length > 0 ? Math.max(...highs) : null;
  let annualizedVolatilityPercent = null;
  const perYear = periodsPerYear(interval);
  if (perYear !== null && closes.length >= 3) {
    const returns = [];
    for (let i = 1; i < closes.length; i += 1) {
      if (closes[i - 1] > 0 && closes[i] > 0) {
        returns.push(Math.log(closes[i] / closes[i - 1]));
      }
    }
    if (returns.length >= 2) {
      const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
      const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
      annualizedVolatilityPercent = round(Math.sqrt(variance) * Math.sqrt(perYear) * 100);
    }
  }
  return {
    candlesCount: candles.length,
    firstClose,
    lastClose,
    changePercent: firstClose !== null && firstClose !== 0 && lastClose !== null ? round((lastClose / firstClose - 1) * 100) : null,
    minLow,
    maxHigh,
    positionInRangePercent: lastClose !== null && minLow !== null && maxHigh !== null && maxHigh > minLow ? round((lastClose - minLow) / (maxHigh - minLow) * 100) : null,
    annualizedVolatilityPercent,
    avgVolume: volumes.length > 0 ? Math.round(volumes.reduce((s, v) => s + v, 0) / volumes.length) : null
  };
}
async function fetchHistory(api, params) {
  const interval = pickCandleInterval(params.days);
  const from = new Date(params.now.getTime() - params.days * MS_PER_DAY).toISOString();
  const to = params.now.toISOString();
  const loadSeries = async (query) => {
    const instrument = await resolveMarketInstrument(api, query);
    const resp = await api.getCandles({ instrumentId: instrument.uid, from, to, interval });
    const candles = toCandleViews(resp.candles ?? []);
    return { instrument, candles, stats: computeCandleStats(candles, interval) };
  };
  const [main, bench] = await Promise.all([
    loadSeries(params.query),
    params.vs ? loadSeries(params.vs) : Promise.resolve(null)
  ]);
  let benchmark = null;
  if (bench) {
    benchmark = {
      ticker: bench.instrument.ticker,
      name: bench.instrument.name,
      changePercent: bench.stats.changePercent,
      outperformancePercent: main.stats.changePercent !== null && bench.stats.changePercent !== null ? round(main.stats.changePercent - bench.stats.changePercent) : null
    };
  }
  return {
    ticker: main.instrument.ticker,
    name: main.instrument.name,
    instrumentKind: main.instrument.kind,
    from,
    to,
    interval,
    stats: main.stats,
    candles: main.candles,
    benchmark
  };
}
function renderHistory(view) {
  const s = view.stats;
  const lines = [
    `${view.ticker} \u2014 ${view.name}`,
    `\u041F\u0435\u0440\u0438\u043E\u0434: ${view.from.slice(0, 10)} \u2014 ${view.to.slice(0, 10)} (\u0441\u0432\u0435\u0447\u0438: ${view.interval.replace("CANDLE_INTERVAL_", "").toLowerCase()})`,
    "",
    `\u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435 \u0437\u0430 \u043F\u0435\u0440\u0438\u043E\u0434: ${s.changePercent !== null ? `${formatSigned(s.changePercent)} %` : DASH}`,
    `\u041F\u0435\u0440\u0432\u0430\u044F/\u043F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u0446\u0435\u043D\u0430: ${s.firstClose !== null ? formatAmount(s.firstClose) : DASH} \u2192 ${s.lastClose !== null ? formatAmount(s.lastClose) : DASH}`,
    `\u0414\u0438\u0430\u043F\u0430\u0437\u043E\u043D: ${s.minLow !== null ? formatAmount(s.minLow) : DASH} \u2026 ${s.maxHigh !== null ? formatAmount(s.maxHigh) : DASH}` + (s.positionInRangePercent !== null ? ` (\u0446\u0435\u043D\u0430 \u043D\u0430 ${formatAmount(s.positionInRangePercent, 0)}% \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D\u0430)` : ""),
    `\u0412\u043E\u043B\u0430\u0442\u0438\u043B\u044C\u043D\u043E\u0441\u0442\u044C (\u0433\u043E\u0434\u043E\u0432\u0430\u044F): ${s.annualizedVolatilityPercent !== null ? `${formatAmount(s.annualizedVolatilityPercent)} %` : DASH}`,
    `\u0421\u0440\u0435\u0434\u043D\u0438\u0439 \u043E\u0431\u044A\u0451\u043C \u0437\u0430 \u0441\u0432\u0435\u0447\u0443: ${s.avgVolume !== null ? formatAmount(s.avgVolume, 0) : DASH}`
  ];
  if (view.benchmark) {
    lines.push(
      "",
      `\u0411\u0435\u043D\u0447\u043C\u0430\u0440\u043A ${view.benchmark.ticker} (${view.benchmark.name}): ${view.benchmark.changePercent !== null ? `${formatSigned(view.benchmark.changePercent)} %` : DASH}` + (view.benchmark.outperformancePercent !== null ? `, \u043E\u0442\u0441\u0442\u0430\u0432\u0430\u043D\u0438\u0435/\u043E\u043F\u0435\u0440\u0435\u0436\u0435\u043D\u0438\u0435: ${formatSigned(view.benchmark.outperformancePercent)} \u043F.\u043F.` : "")
    );
  }
  return lines.join("\n");
}
function renderHistoryChart(view) {
  const closes = view.candles.map((c) => c.close).filter((v) => v !== null);
  if (closes.length < 2) {
    return "\u0413\u0440\u0430\u0444\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: \u043D\u0435\u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u0441\u0432\u0435\u0447\u0435\u0439 \u0437\u0430 \u043F\u0435\u0440\u0438\u043E\u0434.";
  }
  const period = `${view.from.slice(0, 10)} \u2014 ${view.to.slice(0, 10)}`;
  const header = `${view.ticker} \u2014 ${view.name}, \u0446\u0435\u043D\u0430 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F (${period}):`;
  const chart = brailleLineChart(closes, { formatValue: (value) => formatAmount(value, 2) });
  return [header, "", chart].join("\n");
}

// src/commands/instrument.ts
var TRADING_STATUS_LABELS = {
  SECURITY_TRADING_STATUS_NORMAL_TRADING: "\u0438\u0434\u0443\u0442 \u0442\u043E\u0440\u0433\u0438",
  SECURITY_TRADING_STATUS_NOT_AVAILABLE_FOR_TRADING: "\u0442\u043E\u0440\u0433\u0438 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B",
  SECURITY_TRADING_STATUS_OPENING_PERIOD: "\u043F\u0435\u0440\u0438\u043E\u0434 \u043E\u0442\u043A\u0440\u044B\u0442\u0438\u044F",
  SECURITY_TRADING_STATUS_CLOSING_PERIOD: "\u043F\u0435\u0440\u0438\u043E\u0434 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F",
  SECURITY_TRADING_STATUS_BREAK_IN_TRADING: "\u043F\u0435\u0440\u0435\u0440\u044B\u0432 \u0432 \u0442\u043E\u0440\u0433\u0430\u0445",
  SECURITY_TRADING_STATUS_OPENING_AUCTION: "\u0430\u0443\u043A\u0446\u0438\u043E\u043D \u043E\u0442\u043A\u0440\u044B\u0442\u0438\u044F",
  SECURITY_TRADING_STATUS_CLOSING_AUCTION: "\u0430\u0443\u043A\u0446\u0438\u043E\u043D \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F",
  SECURITY_TRADING_STATUS_DARK_POOL_AUCTION: "\u0430\u0443\u043A\u0446\u0438\u043E\u043D \u043A\u0440\u0443\u043F\u043D\u044B\u0445 \u043F\u0430\u043A\u0435\u0442\u043E\u0432",
  SECURITY_TRADING_STATUS_DISCRETE_AUCTION: "\u0434\u0438\u0441\u043A\u0440\u0435\u0442\u043D\u044B\u0439 \u0430\u0443\u043A\u0446\u0438\u043E\u043D",
  SECURITY_TRADING_STATUS_TRADING_AT_CLOSING_AUCTION_PRICE: "\u0442\u043E\u0440\u0433\u0438 \u043F\u043E \u0446\u0435\u043D\u0435 \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F",
  SECURITY_TRADING_STATUS_SESSION_CLOSE: "\u0441\u0435\u0441\u0441\u0438\u044F \u0437\u0430\u043A\u0440\u044B\u0442\u0430",
  SECURITY_TRADING_STATUS_SESSION_OPEN: "\u0441\u0435\u0441\u0441\u0438\u044F \u043E\u0442\u043A\u0440\u044B\u0442\u0430"
};
function buildInstrumentCard(params) {
  const { details, lastPrice, status, futuresMargin } = params;
  const statusEnum = status.tradingStatus ?? null;
  return {
    uid: details.uid,
    ticker: details.ticker ?? null,
    isin: details.isin ?? null,
    name: details.name,
    instrumentType: details.instrumentType ?? null,
    lot: details.lot ?? null,
    currency: details.currency ?? null,
    exchange: details.exchange ?? null,
    countryOfRisk: details.countryOfRiskName ?? details.countryOfRisk ?? null,
    // Опущенные protobuf-JSON message-поля → null (цена без торгов и т.п.).
    lastPrice: quotationToNumberOrNull(lastPrice?.price),
    tradingStatus: statusEnum,
    tradingStatusText: statusEnum ? TRADING_STATUS_LABELS[statusEnum] ?? statusEnum : null,
    apiTradeAvailable: status.apiTradeAvailableFlag ?? details.apiTradeAvailableFlag ?? null,
    forQualInvestor: details.forQualInvestorFlag ?? null,
    futuresMargin: futuresMargin ? {
      initialMarginOnBuy: moneyToNumberOrNull(futuresMargin.initialMarginOnBuy),
      initialMarginOnSell: moneyToNumberOrNull(futuresMargin.initialMarginOnSell),
      minPriceIncrement: quotationToNumberOrNull(futuresMargin.minPriceIncrement),
      minPriceIncrementAmount: quotationToNumberOrNull(futuresMargin.minPriceIncrementAmount)
    } : null
  };
}
async function fetchInstrumentCard(api, query) {
  const found = await resolveInstrument(api, query);
  const { instrument } = await api.getInstrumentByUid(found.uid);
  const [prices, status] = await Promise.all([
    api.getLastPrices([found.uid]),
    api.getTradingStatus(found.uid)
  ]);
  const futuresMargin = instrument.instrumentType === "futures" ? await api.getFuturesMargin(found.uid) : null;
  return buildInstrumentCard({
    details: instrument,
    lastPrice: prices.lastPrices.find((p) => p.instrumentUid === found.uid) ?? prices.lastPrices[0],
    status,
    futuresMargin
  });
}
function renderInstrumentCard(view) {
  const lines = [
    `${view.ticker ?? DASH} \u2014 ${view.name}`,
    `\u0422\u0438\u043F: ${view.instrumentType ?? DASH} | ISIN: ${view.isin ?? DASH} | \u0411\u0438\u0440\u0436\u0430: ${view.exchange ?? DASH}`,
    `\u0421\u0442\u0440\u0430\u043D\u0430 \u0440\u0438\u0441\u043A\u0430: ${view.countryOfRisk ?? DASH} | \u0412\u0430\u043B\u044E\u0442\u0430: ${view.currency?.toUpperCase() ?? DASH} | \u041B\u043E\u0442: ${view.lot ?? DASH}`,
    `\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u0446\u0435\u043D\u0430: ${moneyOrDash(view.lastPrice)}`,
    `\u0421\u0442\u0430\u0442\u0443\u0441 \u0442\u043E\u0440\u0433\u043E\u0432: ${view.tradingStatusText ?? DASH}`,
    `\u0414\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0447\u0435\u0440\u0435\u0437 API: ${view.apiTradeAvailable === null ? DASH : view.apiTradeAvailable ? "\u0434\u0430" : "\u043D\u0435\u0442"}` + (view.forQualInvestor ? " | \u0442\u043E\u043B\u044C\u043A\u043E \u0434\u043B\u044F \u043A\u0432\u0430\u043B\u0438\u0444\u0438\u0446\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0445 \u0438\u043D\u0432\u0435\u0441\u0442\u043E\u0440\u043E\u0432" : "")
  ];
  if (view.futuresMargin) {
    const m = view.futuresMargin;
    lines.push(
      `\u0413\u041E \u043F\u043E\u043A\u0443\u043F\u043A\u0430/\u043F\u0440\u043E\u0434\u0430\u0436\u0430: ${moneyOrDash(m.initialMarginOnBuy)} / ${moneyOrDash(m.initialMarginOnSell)}`,
      // Шаг цены печатаем как есть (не через toFixed): дробность шага
      // произвольна (0.01, 0.0001…) и не должна усекаться до 2 знаков.
      `\u0428\u0430\u0433 \u0446\u0435\u043D\u044B: ${m.minPriceIncrement ?? DASH} (\u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C \u0448\u0430\u0433\u0430: ${moneyOrDash(m.minPriceIncrementAmount)})`
    );
  }
  return lines.join("\n");
}

// src/format/units.ts
var POINT_PRICED_INSTRUMENT_TYPES = ["bond", "futures"];
var POINTS_LABEL = "\u043F\u0442";
var POINTS_CURRENCY_TOKENS = ["pt.", "pt", "point", "points"];
var POINTS_PER_NOMINAL = 100;
function priceUnitFor(instrumentType) {
  return POINT_PRICED_INSTRUMENT_TYPES.includes(instrumentType) ? "point" : "currency";
}
function isPointsCurrency(currency) {
  return typeof currency === "string" && POINTS_CURRENCY_TOKENS.includes(currency.toLowerCase());
}
function priceUnitFromCurrency(currency) {
  if (isPointsCurrency(currency)) {
    return "point";
  }
  if (typeof currency === "string" && currency.trim() !== "") {
    return "currency";
  }
  return null;
}
function formatInstrumentPrice(value, opts) {
  if (opts.unit === "currency") {
    return opts.currency ? `${formatAmount(value)} ${currencySymbol(opts.currency)}` : formatAmount(value);
  }
  const base = `${formatAmount(value)} ${POINTS_LABEL}`;
  if (opts.nominalRub === null || opts.nominalRub === void 0) {
    return base;
  }
  const rubPerUnit = value / POINTS_PER_NOMINAL * opts.nominalRub;
  return `${base} (\u2248 ${formatAmount(rubPerUnit)} \u20BD/\u0448\u0442)`;
}
function formatMoneyAmount(value, currency) {
  if (isPointsCurrency(currency)) {
    return `${formatAmount(value)} ${POINTS_LABEL}`;
  }
  return currency ? `${formatAmount(value)} ${currencySymbol(currency)}` : formatAmount(value);
}

// src/commands/last-trades.ts
var TRADE_DIRECTION_LABELS = {
  TRADE_DIRECTION_BUY: "\u043F\u043E\u043A\u0443\u043F\u043A\u0430",
  TRADE_DIRECTION_SELL: "\u043F\u0440\u043E\u0434\u0430\u0436\u0430"
};
async function fetchLastTrades(api, params) {
  const instrument = await resolveMarketInstrument(api, params.query);
  const from = new Date(params.now.getTime() - params.hours * MS_PER_HOUR).toISOString();
  const to = params.now.toISOString();
  const resp = await api.getLastTrades(instrument.uid, from, to);
  const trades = resp.trades ?? [];
  return {
    ticker: instrument.ticker,
    name: instrument.name,
    // instrumentType у индикативов может быть null — тогда трактуем как валюту.
    priceUnit: instrument.instrumentType ? priceUnitFor(instrument.instrumentType) : "currency",
    currency: instrument.currency,
    trades: trades.map((t) => ({
      time: t.time ?? null,
      direction: t.direction ? TRADE_DIRECTION_LABELS[t.direction] ?? t.direction : null,
      price: quotationToNumberOrNull(t.price),
      quantity: t.quantity ? Number(t.quantity) : null
    }))
  };
}
function renderLastTrades(view) {
  if (view.trades.length === 0) {
    return `${view.name} (${view.ticker}): \u0437\u0430 \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0439 \u043F\u0435\u0440\u0438\u043E\u0434 \u043E\u0431\u0435\u0437\u043B\u0438\u0447\u0435\u043D\u043D\u044B\u0445 \u0441\u0434\u0435\u043B\u043E\u043A \u043D\u0435\u0442.`;
  }
  const table = renderTable(
    ["\u0412\u0440\u0435\u043C\u044F (\u041C\u0421\u041A)", "\u041D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435", "\u0426\u0435\u043D\u0430", "\u041B\u043E\u0442\u044B"],
    view.trades.map((t) => [
      t.time ? formatMoscowDateTime(t.time) : DASH,
      t.direction ?? DASH,
      t.price !== null ? formatInstrumentPrice(t.price, { unit: view.priceUnit, nominalRub: null, currency: view.currency }) : DASH,
      t.quantity !== null ? String(t.quantity) : DASH
    ])
  );
  return `${view.name} (${view.ticker}) \u2014 \u043E\u0431\u0435\u0437\u043B\u0438\u0447\u0435\u043D\u043D\u044B\u0435 \u0441\u0434\u0435\u043B\u043A\u0438:
${table}`;
}

// src/commands/orderbook.ts
function toLevels(entries) {
  return (entries ?? []).filter((e) => e.price !== void 0 && e.quantity !== void 0).map((e) => ({ price: quotationToNumber(e.price), quantity: Number(e.quantity) }));
}
function buildOrderBookView(params) {
  const bids = toLevels(params.resp.bids);
  const asks = toLevels(params.resp.asks);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spreadPercent = bestBid !== null && bestAsk !== null && bestBid + bestAsk > 0 ? round((bestAsk - bestBid) / ((bestAsk + bestBid) / 2) * 100, 4) : null;
  return {
    ticker: params.ticker,
    name: params.name,
    depth: params.resp.depth ?? bids.length,
    bids,
    asks,
    bestBid,
    bestAsk,
    spreadPercent,
    bidVolume: bids.reduce((s, l) => s + l.quantity, 0),
    askVolume: asks.reduce((s, l) => s + l.quantity, 0),
    lastPrice: params.resp.lastPrice ? quotationToNumber(params.resp.lastPrice) : null,
    limitUp: params.resp.limitUp ? quotationToNumber(params.resp.limitUp) : null,
    limitDown: params.resp.limitDown ? quotationToNumber(params.resp.limitDown) : null
  };
}
async function fetchOrderBook(api, query, depth) {
  const instrument = await resolveMarketInstrument(api, query);
  const resp = await api.getOrderBook(instrument.uid, depth);
  return buildOrderBookView({ ticker: instrument.ticker, name: instrument.name, resp });
}
function renderOrderBook(view) {
  const lines = [
    `${view.ticker} \u2014 ${view.name} (\u0441\u0442\u0430\u043A\u0430\u043D, \u0433\u043B\u0443\u0431\u0438\u043D\u0430 ${view.depth})`,
    `\u041B\u0443\u0447\u0448\u0430\u044F \u043F\u043E\u043A\u0443\u043F\u043A\u0430/\u043F\u0440\u043E\u0434\u0430\u0436\u0430: ${view.bestBid !== null ? formatAmount(view.bestBid) : DASH} / ${view.bestAsk !== null ? formatAmount(view.bestAsk) : DASH}` + (view.spreadPercent !== null ? ` | \u0441\u043F\u0440\u0435\u0434 ${formatAmount(view.spreadPercent, 3)} %` : ""),
    `\u041E\u0431\u044A\u0451\u043C \u0432 \u0441\u0442\u0430\u043A\u0430\u043D\u0435 (\u043B\u043E\u0442\u044B): \u043F\u043E\u043A\u0443\u043F\u043A\u0430 ${formatAmount(view.bidVolume, 0)} | \u043F\u0440\u043E\u0434\u0430\u0436\u0430 ${formatAmount(view.askVolume, 0)}`,
    ""
  ];
  if (view.bids.length === 0 && view.asks.length === 0) {
    lines.push("\u0421\u0442\u0430\u043A\u0430\u043D \u043F\u0443\u0441\u0442 \u2014 \u0442\u043E\u0440\u0433\u0438 \u043F\u043E \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0443 \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435 \u0438\u0434\u0443\u0442.");
    return lines.join("\n");
  }
  const rows = Math.max(view.bids.length, view.asks.length);
  const table = renderTable(
    ["\u041F\u043E\u043A\u0443\u043F\u043A\u0430 (\u043B\u043E\u0442\u044B)", "\u0426\u0435\u043D\u0430 bid", "\u0426\u0435\u043D\u0430 ask", "\u041F\u0440\u043E\u0434\u0430\u0436\u0430 (\u043B\u043E\u0442\u044B)"],
    Array.from({ length: rows }, (_, i) => [
      view.bids[i] ? formatAmount(view.bids[i].quantity, 0) : "",
      view.bids[i] ? formatAmount(view.bids[i].price) : "",
      view.asks[i] ? formatAmount(view.asks[i].price) : "",
      view.asks[i] ? formatAmount(view.asks[i].quantity, 0) : ""
    ])
  );
  lines.push(table);
  return lines.join("\n");
}

// src/commands/schedule.ts
function sessionRange(start, end) {
  if (!start || !end) {
    return null;
  }
  return `${formatMoscowTime(start)}\u2013${formatMoscowTime(end)}`;
}
async function fetchSchedule(api, params) {
  const from = params.now.toISOString();
  const to = new Date(params.now.getTime() + params.days * MS_PER_DAY).toISOString();
  const resp = await api.getTradingSchedules(params.exchange, from, to);
  const exchanges = resp.exchanges ?? [];
  if (exchanges.length === 0) {
    throw new AppError({
      code: "APP_TINVEST_SCHEDULE_UNAVAILABLE",
      userMessage: params.exchange ? `\u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0442\u043E\u0440\u0433\u043E\u0432 \u0434\u043B\u044F \u043F\u043B\u043E\u0449\u0430\u0434\u043A\u0438 \xAB${params.exchange}\xBB \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u2014 \u043F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u043F\u043B\u043E\u0449\u0430\u0434\u043A\u0438 \u0438\u043B\u0438 \u0437\u0430\u043F\u0440\u043E\u0441\u0438\u0442\u0435 \u0431\u0435\u0437 \u043D\u0435\u0433\u043E (\u043F\u043E\u043A\u0430\u0436\u0435\u0442 \u0432\u0441\u0435).` : "\u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0442\u043E\u0440\u0433\u043E\u0432 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u0437\u0430 \u0443\u043A\u0430\u0437\u0430\u043D\u043D\u044B\u0439 \u043F\u0435\u0440\u0438\u043E\u0434."
    });
  }
  return {
    exchanges: exchanges.map((e) => ({
      exchange: e.exchange ?? DASH,
      days: (e.days ?? []).map((d) => {
        const trading = d.isTradingDay ?? false;
        return {
          date: d.date ? formatMoscowDate(d.date) : null,
          isTradingDay: trading,
          // Сессии показываем только у торговых дней.
          mainSession: trading ? sessionRange(d.startTime, d.endTime) : null,
          eveningSession: trading ? sessionRange(d.eveningStartTime, d.eveningEndTime) : null
        };
      })
    }))
  };
}
function renderSchedule(view) {
  return view.exchanges.map((e) => {
    const table = renderTable(
      ["\u0414\u0430\u0442\u0430", "\u0422\u043E\u0440\u0433\u0438", "\u041E\u0441\u043D\u043E\u0432\u043D\u0430\u044F (\u041C\u0421\u041A)", "\u0412\u0435\u0447\u0435\u0440\u043D\u044F\u044F (\u041C\u0421\u041A)"],
      e.days.map((d) => [
        d.date ?? DASH,
        d.isTradingDay ? "\u0434\u0430" : "\u043D\u0435\u0442",
        d.mainSession ?? DASH,
        d.eveningSession ?? DASH
      ])
    );
    return `\u041F\u043B\u043E\u0449\u0430\u0434\u043A\u0430: ${e.exchange}
${table}`;
  }).join("\n\n");
}

// src/commands/tech.ts
function lastValue(resp, field2) {
  const values = resp.technicalIndicators ?? [];
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const quotation = values[i][field2];
    if (quotation) {
      return round(quotationToNumber(quotation));
    }
  }
  return null;
}
function buildTechView(params) {
  const rsi = lastValue(params.rsiResp, "signal");
  const smaFast = lastValue(params.smaFastResp, "signal");
  const smaSlow = lastValue(params.smaSlowResp, "signal");
  const macd = lastValue(params.macdResp, "macd");
  const macdSignal = lastValue(params.macdResp, "signal");
  const observations = [];
  if (rsi !== null) {
    if (rsi >= RSI_OVERBOUGHT) {
      observations.push(`RSI ${rsi} \u2014 \u0437\u043E\u043D\u0430 \u043F\u0435\u0440\u0435\u043A\u0443\u043F\u043B\u0435\u043D\u043D\u043E\u0441\u0442\u0438 (\u0432\u044B\u0448\u0435 ${RSI_OVERBOUGHT}).`);
    } else if (rsi <= RSI_OVERSOLD) {
      observations.push(`RSI ${rsi} \u2014 \u0437\u043E\u043D\u0430 \u043F\u0435\u0440\u0435\u043F\u0440\u043E\u0434\u0430\u043D\u043D\u043E\u0441\u0442\u0438 (\u043D\u0438\u0436\u0435 ${RSI_OVERSOLD}).`);
    } else {
      observations.push(`RSI ${rsi} \u2014 \u043D\u0435\u0439\u0442\u0440\u0430\u043B\u044C\u043D\u0430\u044F \u0437\u043E\u043D\u0430.`);
    }
  }
  if (params.lastPrice !== null && smaFast !== null && smaSlow !== null) {
    const above = params.lastPrice > smaFast && params.lastPrice > smaSlow;
    const below = params.lastPrice < smaFast && params.lastPrice < smaSlow;
    if (above) {
      observations.push(`\u0426\u0435\u043D\u0430 \u0432\u044B\u0448\u0435 SMA${SMA_FAST_LENGTH} \u0438 SMA${SMA_SLOW_LENGTH} \u2014 \u0432\u043E\u0441\u0445\u043E\u0434\u044F\u0449\u0430\u044F \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430.`);
    } else if (below) {
      observations.push(`\u0426\u0435\u043D\u0430 \u043D\u0438\u0436\u0435 SMA${SMA_FAST_LENGTH} \u0438 SMA${SMA_SLOW_LENGTH} \u2014 \u043D\u0438\u0441\u0445\u043E\u0434\u044F\u0449\u0430\u044F \u0441\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430.`);
    }
  }
  if (macd !== null && macdSignal !== null) {
    observations.push(
      macd > macdSignal ? "MACD \u0432\u044B\u0448\u0435 \u0441\u0438\u0433\u043D\u0430\u043B\u044C\u043D\u043E\u0439 \u043B\u0438\u043D\u0438\u0438 \u2014 \u0438\u043C\u043F\u0443\u043B\u044C\u0441 \u043D\u0430 \u0441\u0442\u043E\u0440\u043E\u043D\u0435 \u0440\u043E\u0441\u0442\u0430." : "MACD \u043D\u0438\u0436\u0435 \u0441\u0438\u0433\u043D\u0430\u043B\u044C\u043D\u043E\u0439 \u043B\u0438\u043D\u0438\u0438 \u2014 \u0438\u043C\u043F\u0443\u043B\u044C\u0441 \u043D\u0430 \u0441\u0442\u043E\u0440\u043E\u043D\u0435 \u0441\u043D\u0438\u0436\u0435\u043D\u0438\u044F."
    );
  }
  return {
    ticker: params.ticker,
    name: params.name,
    lastPrice: params.lastPrice,
    rsi,
    smaFast,
    smaSlow,
    macd,
    macdSignal,
    observations
  };
}
async function fetchTech(api, query, now) {
  const instrument = await resolveMarketInstrument(api, query);
  const from = new Date(now.getTime() - TECH_LOOKBACK_DAYS * MS_PER_DAY).toISOString();
  const to = now.toISOString();
  const base = {
    instrumentUid: instrument.uid,
    from,
    to,
    interval: "INDICATOR_INTERVAL_ONE_DAY",
    typeOfPrice: "TYPE_OF_PRICE_CLOSE"
  };
  const [prices, rsiResp, smaFastResp, smaSlowResp, macdResp] = await Promise.all([
    api.getLastPrices([instrument.uid]),
    api.getTechAnalysis({ ...base, indicatorType: "INDICATOR_TYPE_RSI", length: RSI_LENGTH }),
    api.getTechAnalysis({ ...base, indicatorType: "INDICATOR_TYPE_SMA", length: SMA_FAST_LENGTH }),
    api.getTechAnalysis({ ...base, indicatorType: "INDICATOR_TYPE_SMA", length: SMA_SLOW_LENGTH }),
    api.getTechAnalysis({
      ...base,
      indicatorType: "INDICATOR_TYPE_MACD",
      smoothing: { fastLength: MACD_FAST, slowLength: MACD_SLOW, signalSmoothing: MACD_SIGNAL }
    })
  ]);
  const lastPriceQuotation = prices.lastPrices[0]?.price;
  return buildTechView({
    ticker: instrument.ticker,
    name: instrument.name,
    lastPrice: lastPriceQuotation ? round(quotationToNumber(lastPriceQuotation)) : null,
    rsiResp,
    smaFastResp,
    smaSlowResp,
    macdResp
  });
}
function renderTech(view) {
  const value = (v) => v !== null ? formatAmount(v) : DASH;
  const lines = [
    `${view.ticker} \u2014 ${view.name} (\u0434\u043D\u0435\u0432\u043D\u044B\u0435 \u0438\u043D\u0434\u0438\u043A\u0430\u0442\u043E\u0440\u044B)`,
    `\u0426\u0435\u043D\u0430: ${value(view.lastPrice)}`,
    `RSI(${RSI_LENGTH}): ${value(view.rsi)}`,
    `SMA(${SMA_FAST_LENGTH}): ${value(view.smaFast)} | SMA(${SMA_SLOW_LENGTH}): ${value(view.smaSlow)}`,
    `MACD: ${value(view.macd)} | \u0441\u0438\u0433\u043D\u0430\u043B\u044C\u043D\u0430\u044F: ${value(view.macdSignal)}`
  ];
  if (view.observations.length > 0) {
    lines.push("", ...view.observations.map((o) => `\u2022 ${o}`));
  }
  return lines.join("\n");
}

// src/cli/register-market.ts
function registerMarketCommands(program3) {
  program3.command("history").description("\u0434\u0438\u043D\u0430\u043C\u0438\u043A\u0430 \u0446\u0435\u043D\u044B \u0437\u0430 \u043F\u0435\u0440\u0438\u043E\u0434: \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435, \u0434\u0438\u0430\u043F\u0430\u0437\u043E\u043D, \u0432\u043E\u043B\u0430\u0442\u0438\u043B\u044C\u043D\u043E\u0441\u0442\u044C, \u0431\u0435\u043D\u0447\u043C\u0430\u0440\u043A").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN (\u0438\u043D\u0434\u0435\u043A\u0441\u044B \u0442\u043E\u0436\u0435: IMOEX, RTSI)").option("-d, --days <n>", "\u043F\u0435\u0440\u0438\u043E\u0434 \u0432 \u0434\u043D\u044F\u0445", String(DEFAULT_HISTORY_DAYS)).option("--vs <ticker>", "\u0441\u0440\u0430\u0432\u043D\u0438\u0442\u044C \u0441 \u0431\u0435\u043D\u0447\u043C\u0430\u0440\u043A\u043E\u043C (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, IMOEX)").option("--chart", "\u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0431\u0440\u0430\u0439\u043B\u044C-\u043B\u0438\u043D\u0438\u044E \u0446\u0435\u043D\u044B \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u044F \u0437\u0430 \u043F\u0435\u0440\u0438\u043E\u0434").action(
    async (query, opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchHistory(client, {
        query,
        days: parsePositiveInt(opts.days, "--days"),
        vs: opts.vs,
        now: /* @__PURE__ */ new Date()
      });
      return withChart(json, view, renderHistory(view), opts.chart ? renderHistoryChart(view) : void 0);
    })
  );
  program3.command("instrument").description("\u0443\u043D\u0438\u0432\u0435\u0440\u0441\u0430\u043B\u044C\u043D\u0430\u044F \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u0430\u043A\u0442\u0438\u0432\u0430: \u0442\u0438\u043F, \u043B\u043E\u0442, \u0446\u0435\u043D\u0430, \u0441\u0442\u0430\u0442\u0443\u0441 \u0442\u043E\u0440\u0433\u043E\u0432, \u0413\u041E \u0444\u044C\u044E\u0447\u0435\u0440\u0441\u0430").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430").action(
    async (query, _opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchInstrumentCard(client, query);
      return json ? view : renderInstrumentCard(view);
    })
  );
  program3.command("orderbook").description("\u0431\u0438\u0440\u0436\u0435\u0432\u043E\u0439 \u0441\u0442\u0430\u043A\u0430\u043D: \u043B\u0443\u0447\u0448\u0438\u0435 \u0446\u0435\u043D\u044B, \u0441\u043F\u0440\u0435\u0434, \u043E\u0431\u044A\u0451\u043C\u044B (\u043E\u0446\u0435\u043D\u043A\u0430 \u043B\u0438\u043A\u0432\u0438\u0434\u043D\u043E\u0441\u0442\u0438)").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430").option("--depth <n>", "\u0433\u043B\u0443\u0431\u0438\u043D\u0430 \u0441\u0442\u0430\u043A\u0430\u043D\u0430", String(ORDERBOOK_DEPTH_DEFAULT)).action(
    async (query, opts, cmd) => runCommand(cmd, async (client, json) => {
      const depth = parsePositiveInt(opts.depth, "--depth", ORDERBOOK_DEPTH_MAX);
      const view = await fetchOrderBook(client, query, depth);
      return json ? view : renderOrderBook(view);
    })
  );
  program3.command("tech").description("\u0442\u0435\u0445\u043D\u0438\u0447\u0435\u0441\u043A\u0438\u0435 \u0438\u043D\u0434\u0438\u043A\u0430\u0442\u043E\u0440\u044B: RSI, SMA(20/50), MACD (\u0434\u043D\u0435\u0432\u043D\u043E\u0439 \u0438\u043D\u0442\u0435\u0440\u0432\u0430\u043B)").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430").action(
    async (query, _opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchTech(client, query, /* @__PURE__ */ new Date());
      return json ? view : renderTech(view);
    })
  );
  program3.command("schedule").description("\u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0442\u043E\u0440\u0433\u043E\u0432 \u043F\u043B\u043E\u0449\u0430\u0434\u043E\u043A: \u043A\u043E\u0433\u0434\u0430 \u043E\u0442\u043A\u0440\u044B\u0442\u044B \u0441\u0435\u0441\u0441\u0438\u0438 (\u0432\u0440\u0435\u043C\u044F \u0432 \u041C\u0421\u041A)").argument("[exchange]", "\u043F\u043B\u043E\u0449\u0430\u0434\u043A\u0430 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, MOEX); \u0431\u0435\u0437 \u043D\u0435\u0451 \u2014 \u0432\u0441\u0435 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0435").option("-d, --days <n>", "\u043F\u0435\u0440\u0438\u043E\u0434 \u0432\u043F\u0435\u0440\u0451\u0434 \u0432 \u0434\u043D\u044F\u0445", String(SCHEDULE_DEFAULT_DAYS)).action(
    async (exchange, opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchSchedule(client, {
        exchange,
        days: parsePositiveInt(opts.days, "--days"),
        now: /* @__PURE__ */ new Date()
      });
      return json ? view : renderSchedule(view);
    })
  );
  program3.command("last-trades").description("\u043B\u0435\u043D\u0442\u0430 \u043E\u0431\u0435\u0437\u043B\u0438\u0447\u0435\u043D\u043D\u044B\u0445 \u0441\u0434\u0435\u043B\u043E\u043A \u0440\u044B\u043D\u043A\u0430 \u043F\u043E \u0431\u0443\u043C\u0430\u0433\u0435 (\u043E\u0446\u0435\u043D\u043A\u0430 \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u0438/\u043B\u0438\u043A\u0432\u0438\u0434\u043D\u043E\u0441\u0442\u0438)").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430").option("--hours <n>", "\u043F\u0435\u0440\u0438\u043E\u0434 \u043D\u0430\u0437\u0430\u0434 \u0432 \u0447\u0430\u0441\u0430\u0445", String(LAST_TRADES_DEFAULT_HOURS)).action(
    async (query, opts, cmd) => runCommand(cmd, async (client, json) => {
      const view = await fetchLastTrades(client, {
        query,
        hours: parsePositiveInt(opts.hours, "--hours"),
        now: /* @__PURE__ */ new Date()
      });
      return json ? view : renderLastTrades(view);
    })
  );
}

// src/catalog/coupon-cache.ts
var import_node_path6 = __toESM(require("node:path"), 1);
var COUPON_CACHE_SCHEMA_VERSION = 1;
function couponCachePath(cacheDir, contour) {
  return import_node_path6.default.join(cacheDir, `coupons-${contour}.json`);
}
function loadCouponCache(filePath) {
  const cache = readVersionedCache(filePath, COUPON_CACHE_SCHEMA_VERSION, "\u043A\u0443\u043F\u043E\u043D\u043E\u0432");
  return cache && typeof cache === "object" ? cache : {};
}
function saveCouponCache(filePath, cache) {
  const current = loadCouponCache(filePath);
  writeVersionedCache(filePath, COUPON_CACHE_SCHEMA_VERSION, { ...current, ...cache });
}
function getFreshCouponEntry(cache, uid, now) {
  const entry = cache[uid];
  if (!entry || typeof entry.savedAt !== "string" || !Array.isArray(entry.events)) {
    return null;
  }
  const age = now.getTime() - Date.parse(entry.savedAt);
  return age >= 0 && age <= COUPON_CACHE_TTL_MS ? entry : null;
}

// src/commands/screen-bonds.ts
var RISK_ORDER = {
  RISK_LEVEL_LOW: 1,
  RISK_LEVEL_MODERATE: 2,
  RISK_LEVEL_HIGH: 3
};
var RISK_MAX_VALUE = {
  low: 1,
  moderate: 2,
  high: 3
};
function yearsBetween(from, toIso) {
  return (new Date(toIso).getTime() - from.getTime()) / MS_PER_YEAR;
}
function horizonOf(item, now) {
  const offer = item.callDate && Date.parse(item.callDate) > now.getTime() ? item.callDate : null;
  if (offer) {
    return { date: offer, toOffer: true };
  }
  return item.maturityDate ? { date: item.maturityDate, toOffer: false } : null;
}
function staticFilterBonds(items, filter, now) {
  return items.filter((item) => {
    if (item.currency !== filter.currency || item.apiTradeAvailableFlag === false) {
      return false;
    }
    if (item.buyAvailableFlag === false) {
      return false;
    }
    if (item.floatingCouponFlag || item.amortizationFlag || item.perpetualFlag || item.subordinatedFlag) {
      return false;
    }
    if (item.forQualInvestorFlag && !filter.includeQual) {
      return false;
    }
    const horizon = horizonOf(item, now);
    if (!horizon) {
      return false;
    }
    if (horizon.toOffer && !filter.includeOffer) {
      return false;
    }
    const years = yearsBetween(now, horizon.date);
    if (years <= 0) {
      return false;
    }
    if (filter.yearsMin !== null && years < filter.yearsMin) {
      return false;
    }
    if (filter.yearsMax !== null && years > filter.yearsMax) {
      return false;
    }
    if (filter.riskMax !== null) {
      const level = item.riskLevel ? RISK_ORDER[item.riskLevel] : void 0;
      if (level === void 0 || level > RISK_MAX_VALUE[filter.riskMax]) {
        return false;
      }
    }
    return true;
  });
}
function rankAndCapCandidates(items, cap) {
  return [...items].sort((a, b) => {
    const liquidity = Number(Boolean(b.liquidityFlag)) - Number(Boolean(a.liquidityFlag));
    if (liquidity !== 0) {
      return liquidity;
    }
    return (a.maturityDate ?? "9999").localeCompare(b.maturityDate ?? "9999");
  }).slice(0, cap);
}
async function screenBonds(api, params) {
  const { filter, mode, now } = params;
  const cacheDir = params.cacheDir ?? CATALOG_CACHE_DIR;
  const warnings = [];
  const catalog = await loadCatalog(api, "bonds", mode, now, cacheDir);
  const matched = staticFilterBonds(catalog.items, filter, now);
  const candidates = rankAndCapCandidates(matched, filter.maxCandidates);
  const droppedByCap = matched.length - candidates.length;
  if (droppedByCap > 0) {
    warnings.push(
      `\u041F\u043E\u0434 \u0444\u0438\u043B\u044C\u0442\u0440 \u043F\u043E\u043F\u0430\u043B\u043E ${matched.length} \u0432\u044B\u043F\u0443\u0441\u043A\u043E\u0432; YTM \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u0430\u043D \u043F\u043E ${candidates.length} \u043D\u0430\u0438\u0431\u043E\u043B\u0435\u0435 \u043B\u0438\u043A\u0432\u0438\u0434\u043D\u044B\u043C (\u043F\u043E\u0442\u043E\u043B\u043E\u043A --max-candidates). \u041E\u0442\u0431\u0440\u043E\u0448\u0435\u043D\u043E: ${droppedByCap}.`
    );
  }
  const priceByUid = /* @__PURE__ */ new Map();
  for (let i = 0; i < candidates.length; i += LAST_PRICES_CHUNK) {
    const chunk = candidates.slice(i, i + LAST_PRICES_CHUNK);
    const { lastPrices } = await api.getLastPrices(chunk.map((c) => c.uid));
    for (const price of lastPrices) {
      if (price.price && price.instrumentUid) {
        priceByUid.set(price.instrumentUid, quotationToNumber(price.price));
      }
    }
  }
  const couponCacheFile = couponCachePath(cacheDir, contourForMode(mode));
  const couponCache = loadCouponCache(couponCacheFile);
  const toFetch = candidates.filter(
    (c) => priceByUid.has(c.uid) && !getFreshCouponEntry(couponCache, c.uid, now)
  );
  if (toFetch.length > 0) {
    console.error(`\u0421\u043A\u0440\u0438\u043D\u0435\u0440: \u0437\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u044E \u0433\u0440\u0430\u0444\u0438\u043A\u0438 \u043A\u0443\u043F\u043E\u043D\u043E\u0432 \u043F\u043E ${toFetch.length} \u0432\u044B\u043F\u0443\u0441\u043A\u0430\u043C...`);
    const fetched = await mapWithConcurrency(
      toFetch,
      { concurrency: BATCH_CONCURRENCY, minIntervalMs: BATCH_MIN_INTERVAL_MS },
      async (item) => {
        const from = new Date(now.getTime() - MS_PER_DAY).toISOString();
        const to = new Date(Date.parse(item.maturityDate ?? item.callDate) + MS_PER_DAY).toISOString();
        const resp = await api.getBondCoupons(item.uid, from, to);
        return [item.uid, resp.events ?? []];
      }
    );
    for (const [uid, events] of fetched) {
      couponCache[uid] = { savedAt: now.toISOString(), events };
    }
    saveCouponCache(couponCacheFile, couponCache);
  }
  const rows = [];
  let computed = 0;
  for (const item of candidates) {
    const pricePercent = priceByUid.get(item.uid);
    const nominal = item.nominal ? moneyToNumber(item.nominal) : null;
    const horizon = horizonOf(item, now);
    const events = couponCache[item.uid]?.events;
    if (pricePercent === void 0 || nominal === null || !horizon || !events) {
      continue;
    }
    const horizonTime = Date.parse(horizon.date);
    const future = events.filter((c) => {
      const t = Date.parse(c.couponDate);
      return t > now.getTime() && t <= horizonTime + MS_PER_DAY;
    }).sort((a, b) => a.couponDate.localeCompare(b.couponDate));
    if (future.length > 0 && !future.every((c) => couponAmount(c) !== null)) {
      continue;
    }
    const aci = item.aciValue ? moneyToNumber(item.aciValue) : 0;
    const dirtyPrice = pricePercent / 100 * nominal + aci;
    const flows = future.map((c) => ({
      date: new Date(c.couponDate),
      amount: couponAmount(c)
    }));
    flows.push({ date: new Date(horizon.date), amount: nominal });
    const ytm = computeEffectiveYtmPercent(flows, dirtyPrice, now);
    computed += 1;
    if (ytm === null || filter.ytmMin !== null && ytm < filter.ytmMin) {
      continue;
    }
    rows.push({
      ticker: item.ticker,
      isin: item.isin ?? null,
      name: item.name,
      sector: item.sector ?? null,
      pricePercent: round(pricePercent),
      ytmPercent: round(ytm),
      toOffer: horizon.toOffer,
      horizonDate: horizon.date.slice(0, 10),
      yearsToHorizon: round(yearsBetween(now, horizon.date)),
      durationYears: (() => {
        const duration = computeMacaulayDurationYears(flows, ytm, now);
        return duration !== null ? round(duration) : null;
      })(),
      couponsPerYear: item.couponQuantityPerYear ?? null,
      riskLevel: item.riskLevel ?? null
    });
  }
  rows.sort((a, b) => b.ytmPercent - a.ytmPercent);
  return {
    totalInCatalog: catalog.items.length,
    matchedStatic: matched.length,
    computed,
    droppedByCap,
    rows: rows.slice(0, filter.top),
    warnings
  };
}
function defaultScreenBondsFilter() {
  return {
    currency: "rub",
    yearsMin: null,
    yearsMax: null,
    ytmMin: null,
    riskMax: null,
    includeOffer: false,
    includeQual: false,
    top: SCREEN_TOP_DEFAULT,
    maxCandidates: SCREEN_BONDS_MAX_CANDIDATES
  };
}
function renderScreenBonds(view) {
  const lines = [
    `\u041A\u0430\u0442\u0430\u043B\u043E\u0433: ${view.totalInCatalog} \u0432\u044B\u043F\u0443\u0441\u043A\u043E\u0432 | \u043F\u043E\u0434 \u0444\u0438\u043B\u044C\u0442\u0440: ${view.matchedStatic} | \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u0430\u043D\u043E: ${view.computed}`,
    ""
  ];
  if (view.rows.length === 0) {
    lines.push("\u041F\u043E\u0434\u0445\u043E\u0434\u044F\u0449\u0438\u0445 \u0432\u044B\u043F\u0443\u0441\u043A\u043E\u0432 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u2014 \u043E\u0441\u043B\u0430\u0431\u044C\u0442\u0435 \u0444\u0438\u043B\u044C\u0442\u0440\u044B.");
  } else {
    lines.push(
      renderTable(
        ["\u0422\u0438\u043A\u0435\u0440", "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435", "\u0426\u0435\u043D\u0430 %", "YTM %", "\u0413\u043E\u0440\u0438\u0437\u043E\u043D\u0442", "\u041B\u0435\u0442", "\u0414\u044E\u0440\u0430\u0446\u0438\u044F", "\u0420\u0438\u0441\u043A"],
        view.rows.map((r) => [
          r.ticker,
          truncate(r.name, 30),
          formatAmount(r.pricePercent),
          formatAmount(r.ytmPercent),
          `${r.horizonDate}${r.toOffer ? " (\u043E\u0444\u0435\u0440\u0442\u0430)" : ""}`,
          formatAmount(r.yearsToHorizon, 1),
          moneyOrDash(r.durationYears, 1),
          r.riskLevel?.replace("RISK_LEVEL_", "").toLowerCase() ?? DASH
        ])
      )
    );
  }
  for (const warning of view.warnings) {
    lines.push("", `\u26A0 ${warning}`);
  }
  return lines.join("\n");
}

// src/commands/screen-shares.ts
var NAME_MAX_WIDTH = 24;
function joinAndFilterShares(shares, fundamentalsByAssetUid, filter) {
  const rows = [];
  for (const share of shares) {
    const fundamentals = share.assetUid ? fundamentalsByAssetUid.get(share.assetUid) : void 0;
    const pe = metricOrNull(fundamentals?.peRatioTtm);
    const pb = metricOrNull(fundamentals?.priceToBookTtm);
    const roe = metricOrNull(fundamentals?.roe);
    const divYield = metricOrNull(fundamentals?.dividendYieldDailyTtm);
    if (filter.peMax !== null && (pe === null || pe <= 0 || pe > filter.peMax)) {
      continue;
    }
    if (filter.pbMax !== null && (pb === null || pb <= 0 || pb > filter.pbMax)) {
      continue;
    }
    if (filter.roeMin !== null && (roe === null || roe < filter.roeMin)) {
      continue;
    }
    if (filter.divMin !== null && (divYield === null || divYield < filter.divMin)) {
      continue;
    }
    if (filter.sector !== null && (share.sector ?? "").toLowerCase() !== filter.sector.toLowerCase()) {
      continue;
    }
    const cap = metricOrNull(fundamentals?.marketCapitalization);
    rows.push({
      ticker: share.ticker,
      name: share.name,
      sector: share.sector ?? null,
      marketCapBillions: cap !== null ? round(cap / 1e9) : null,
      pe: pe !== null ? round(pe) : null,
      pb: pb !== null ? round(pb) : null,
      roe: roe !== null ? round(roe) : null,
      divYieldTtm: divYield !== null ? round(divYield) : null,
      evEbitda: metricOrNull(fundamentals?.evToEbitdaMrq) !== null ? round(fundamentals.evToEbitdaMrq) : null,
      netDebtToEbitda: metricOrNull(fundamentals?.netDebtToEbitda) !== null ? round(fundamentals.netDebtToEbitda) : null
    });
  }
  const key = filter.sort;
  const valueOf = (row) => {
    switch (key) {
      case "pe":
        return row.pe;
      case "roe":
        return row.roe;
      case "div":
        return row.divYieldTtm;
      case "cap":
        return row.marketCapBillions;
    }
  };
  const ascending = key === "pe";
  rows.sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av === null && bv === null) {
      return 0;
    }
    if (av === null) {
      return 1;
    }
    if (bv === null) {
      return -1;
    }
    return ascending ? av - bv : bv - av;
  });
  return rows;
}
async function screenShares(api, params) {
  const { filter, mode, now } = params;
  const warnings = [];
  const catalog = await loadCatalog(api, "shares", mode, now);
  const base = catalog.items.filter(
    (s) => s.currency === filter.currency && s.apiTradeAvailableFlag !== false && s.assetUid
  );
  const universe = base.filter((s) => s.shareType !== "SHARE_TYPE_PREFERRED");
  const prefsExcluded = base.length - universe.length;
  if (prefsExcluded > 0) {
    warnings.push(
      `\u041F\u0440\u0438\u0432\u0438\u043B\u0435\u0433\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0435 \u0430\u043A\u0446\u0438\u0438 (${prefsExcluded} \u0448\u0442.) \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u044B \u0438\u0437 \u0441\u043A\u0440\u0438\u043D\u0438\u043D\u0433\u0430: API \u0441\u0447\u0438\u0442\u0430\u0435\u0442 \u0438\u0445 \u043A\u043E\u044D\u0444\u0444\u0438\u0446\u0438\u0435\u043D\u0442\u044B \u043F\u043E \u043A\u0430\u043F\u0438\u0442\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u0438 \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u0440\u0435\u0444\u043E\u0432, \u0447\u0442\u043E \u0438\u0441\u043A\u0430\u0436\u0430\u0435\u0442 P/E \u0438 P/B.`
    );
  }
  const assetUids = [...new Set(universe.map((s) => s.assetUid))];
  const chunks = [];
  for (let i = 0; i < assetUids.length; i += FUNDAMENTALS_CHUNK) {
    chunks.push(assetUids.slice(i, i + FUNDAMENTALS_CHUNK));
  }
  const responses = await mapWithConcurrency(
    chunks,
    { concurrency: BATCH_CONCURRENCY, minIntervalMs: BATCH_MIN_INTERVAL_MS },
    async (chunk) => api.getAssetFundamentals(chunk)
  );
  const fundamentalsByAssetUid = /* @__PURE__ */ new Map();
  for (const resp of responses) {
    for (const item of resp.fundamentals ?? []) {
      fundamentalsByAssetUid.set(item.assetUid, item);
    }
  }
  if (fundamentalsByAssetUid.size === 0) {
    warnings.push("API \u043D\u0435 \u0432\u0435\u0440\u043D\u0443\u043B \u0444\u0443\u043D\u0434\u0430\u043C\u0435\u043D\u0442\u0430\u043B\u044C\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445 \u2014 \u0441\u043A\u0440\u0438\u043D\u0438\u043D\u0433 \u043F\u043E \u043C\u0435\u0442\u0440\u0438\u043A\u0430\u043C \u043D\u0435\u0432\u043E\u0437\u043C\u043E\u0436\u0435\u043D.");
  }
  const rows = joinAndFilterShares(universe, fundamentalsByAssetUid, filter);
  return {
    totalInCatalog: catalog.items.length,
    matchedUniverse: universe.length,
    withFundamentals: fundamentalsByAssetUid.size,
    rows: rows.slice(0, filter.top),
    warnings
  };
}
function defaultScreenSharesFilter() {
  return {
    currency: "rub",
    peMax: null,
    pbMax: null,
    roeMin: null,
    divMin: null,
    sector: null,
    sort: "cap",
    top: SCREEN_TOP_DEFAULT
  };
}
function renderScreenShares(view) {
  const lines = [
    `\u041A\u0430\u0442\u0430\u043B\u043E\u0433: ${view.totalInCatalog} \u0430\u043A\u0446\u0438\u0439 | \u0432\u0441\u0435\u043B\u0435\u043D\u043D\u0430\u044F: ${view.matchedUniverse} | \u0441 \u0444\u0443\u043D\u0434\u0430\u043C\u0435\u043D\u0442\u0430\u043B\u043E\u043C: ${view.withFundamentals}`,
    ""
  ];
  if (view.rows.length === 0) {
    lines.push("\u041F\u043E\u0434\u0445\u043E\u0434\u044F\u0449\u0438\u0445 \u0430\u043A\u0446\u0438\u0439 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u2014 \u043E\u0441\u043B\u0430\u0431\u044C\u0442\u0435 \u0444\u0438\u043B\u044C\u0442\u0440\u044B.");
  } else {
    lines.push(
      renderTable(
        ["\u0422\u0438\u043A\u0435\u0440", "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435", "\u0421\u0435\u043A\u0442\u043E\u0440", "\u041A\u0430\u043F., \u043C\u043B\u0440\u0434", "P/E", "P/B", "ROE %", "\u0414\u0438\u0432. %"],
        view.rows.map((r) => [
          r.ticker,
          truncate(r.name, NAME_MAX_WIDTH),
          r.sector ?? DASH,
          moneyOrDash(r.marketCapBillions, 0),
          moneyOrDash(r.pe, 1),
          moneyOrDash(r.pb, 1),
          moneyOrDash(r.roe, 1),
          moneyOrDash(r.divYieldTtm, 1)
        ])
      )
    );
  }
  for (const warning of view.warnings) {
    lines.push("", `\u26A0 ${warning}`);
  }
  return lines.join("\n");
}

// src/cli/register-screen.ts
function parseEnumOption(raw, optionName, allowed) {
  if (allowed.includes(raw)) {
    return raw;
  }
  throw new AppError({
    code: "APP_CLI_INVALID_ARGUMENT",
    userMessage: `\u041F\u0430\u0440\u0430\u043C\u0435\u0442\u0440 ${optionName} \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u0442 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u044F: ${allowed.join(", ")}; \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E \xAB${raw}\xBB.`
  });
}
function registerScreenCommands(program3) {
  const screen = program3.command("screen").description("\u0441\u043A\u0440\u0438\u043D\u0435\u0440\u044B \u043F\u043E \u0432\u0441\u0435\u043C\u0443 \u0441\u043F\u0440\u0430\u0432\u043E\u0447\u043D\u0438\u043A\u0443 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u043E\u0432");
  screen.command("bonds").description("\u0441\u043A\u0440\u0438\u043D\u0435\u0440 \u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u0439: YTM, \u0441\u0440\u043E\u043A, \u0440\u0438\u0441\u043A (\u0444\u043B\u043E\u0430\u0442\u0435\u0440\u044B/\u0430\u043C\u043E\u0440\u0442\u0438\u0437\u0430\u0446\u0438\u044F \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u044B)").option("--ytm-min <pct>", "\u043C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u0430\u044F \u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C \u043A \u043F\u043E\u0433\u0430\u0448\u0435\u043D\u0438\u044E, %").option("--years-min <n>", "\u043C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0440\u043E\u043A \u0434\u043E \u043F\u043E\u0433\u0430\u0448\u0435\u043D\u0438\u044F/\u043E\u0444\u0435\u0440\u0442\u044B, \u043B\u0435\u0442").option("--years-max <n>", "\u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0440\u043E\u043A \u0434\u043E \u043F\u043E\u0433\u0430\u0448\u0435\u043D\u0438\u044F/\u043E\u0444\u0435\u0440\u0442\u044B, \u043B\u0435\u0442").option("--risk-max <level>", "\u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 \u0443\u0440\u043E\u0432\u0435\u043D\u044C \u0440\u0438\u0441\u043A\u0430: low | moderate | high").option("--include-offer", "\u0432\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u0432\u044B\u043F\u0443\u0441\u043A\u0438 \u0441 \u043E\u0444\u0435\u0440\u0442\u043E\u0439 (\u0440\u0430\u0441\u0447\u0451\u0442 \u043A \u043E\u0444\u0435\u0440\u0442\u0435)").option("--include-qual", "\u0432\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u0431\u0443\u043C\u0430\u0433\u0438 \xAB\u0442\u043E\u043B\u044C\u043A\u043E \u0434\u043B\u044F \u043A\u0432\u0430\u043B\u043E\u0432\xBB").option("--currency <code>", "\u0432\u0430\u043B\u044E\u0442\u0430 \u043D\u043E\u043C\u0438\u043D\u0430\u043B\u0430", "rub").option("--top <n>", "\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043B\u0443\u0447\u0448\u0438\u0445 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C").option("--max-candidates <n>", "\u043F\u043E\u0442\u043E\u043B\u043E\u043A \u043A\u0430\u043D\u0434\u0438\u0434\u0430\u0442\u043E\u0432 \u0434\u043B\u044F \u0440\u0430\u0441\u0447\u0451\u0442\u0430 YTM").action(
    async (opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      const filter = defaultScreenBondsFilter();
      filter.currency = opts.currency.toLowerCase();
      filter.ytmMin = opts.ytmMin !== void 0 ? parsePositiveNumber(opts.ytmMin, "--ytm-min") : null;
      filter.yearsMin = opts.yearsMin !== void 0 ? parsePositiveNumber(opts.yearsMin, "--years-min") : null;
      filter.yearsMax = opts.yearsMax !== void 0 ? parsePositiveNumber(opts.yearsMax, "--years-max") : null;
      filter.riskMax = opts.riskMax !== void 0 ? parseEnumOption(opts.riskMax, "--risk-max", ["low", "moderate", "high"]) : null;
      filter.includeOffer = Boolean(opts.includeOffer);
      filter.includeQual = Boolean(opts.includeQual);
      if (opts.top !== void 0) {
        filter.top = parsePositiveInt(opts.top, "--top");
      }
      if (opts.maxCandidates !== void 0) {
        filter.maxCandidates = parsePositiveInt(opts.maxCandidates, "--max-candidates");
      }
      const view = await screenBonds(client, { filter, mode, now: /* @__PURE__ */ new Date() });
      return json ? view : renderScreenBonds(view);
    })
  );
  screen.command("shares").description("\u0441\u043A\u0440\u0438\u043D\u0435\u0440 \u0430\u043A\u0446\u0438\u0439: P/E, P/B, ROE, \u0434\u0438\u0432\u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C, \u0441\u0435\u043A\u0442\u043E\u0440").option("--pe-max <n>", "\u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 P/E").option("--pb-max <n>", "\u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 P/B").option("--roe-min <pct>", "\u043C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u044B\u0439 ROE, %").option("--div-min <pct>", "\u043C\u0438\u043D\u0438\u043C\u0430\u043B\u044C\u043D\u0430\u044F \u0434\u0438\u0432\u0434\u043E\u0445\u043E\u0434\u043D\u043E\u0441\u0442\u044C TTM, %").option("--sector <name>", "\u0441\u0435\u043A\u0442\u043E\u0440 (energy, financial, it, ...)").option("--sort <key>", "\u0441\u043E\u0440\u0442\u0438\u0440\u043E\u0432\u043A\u0430: pe | roe | div | cap", "cap").option("--currency <code>", "\u0432\u0430\u043B\u044E\u0442\u0430 \u0442\u043E\u0440\u0433\u043E\u0432", "rub").option("--top <n>", "\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C").action(
    async (opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      const filter = defaultScreenSharesFilter();
      filter.currency = opts.currency.toLowerCase();
      filter.peMax = opts.peMax !== void 0 ? parsePositiveNumber(opts.peMax, "--pe-max") : null;
      filter.pbMax = opts.pbMax !== void 0 ? parsePositiveNumber(opts.pbMax, "--pb-max") : null;
      filter.roeMin = opts.roeMin !== void 0 ? parsePositiveNumber(opts.roeMin, "--roe-min") : null;
      filter.divMin = opts.divMin !== void 0 ? parsePositiveNumber(opts.divMin, "--div-min") : null;
      filter.sector = opts.sector ?? null;
      filter.sort = parseEnumOption(opts.sort, "--sort", ["pe", "roe", "div", "cap"]);
      if (opts.top !== void 0) {
        filter.top = parsePositiveInt(opts.top, "--top");
      }
      const view = await screenShares(client, { filter, mode, now: /* @__PURE__ */ new Date() });
      return json ? view : renderScreenShares(view);
    })
  );
}

// src/cli/register-session.ts
var STONKS_WARNING = "\u26A0\uFE0F \u0412\u043A\u043B\u044E\u0447\u0451\u043D stonks-\u0440\u0435\u0436\u0438\u043C (T_INVEST_STONKS_MODE): \u0430\u0433\u0435\u043D\u0442 \u043C\u043E\u0436\u0435\u0442 \u0441\u043E\u0432\u0435\u0440\u0448\u0430\u0442\u044C \u0441\u0434\u0435\u043B\u043A\u0438 \u0440\u0435\u0430\u043B\u044C\u043D\u044B\u043C\u0438 \u0434\u0435\u043D\u044C\u0433\u0430\u043C\u0438 \u0411\u0415\u0417 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0439. \u0412\u044B \u043F\u0435\u0440\u0435\u0434\u0430\u0451\u0442\u0435 \u043F\u043E\u043B\u043D\u044B\u0439 \u0430\u0432\u0442\u043E\u043D\u043E\u043C\u043D\u044B\u0439 \u0434\u043E\u0441\u0442\u0443\u043F \u043A \u0441\u0447\u0451\u0442\u0443 \u2014 \u043E\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0435\u043D\u043D\u043E\u0441\u0442\u044C \u043D\u0430 \u0432\u0430\u0441, \u044D\u0442\u043E \u043D\u0435\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E.";
function assertSandboxMode(mode, command) {
  if (mode !== "sandbox") {
    throw new AppError({
      code: "APP_TINVEST_SANDBOX_ONLY",
      userMessage: `\u041A\u043E\u043C\u0430\u043D\u0434\u0430 \xAB${command}\xBB \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0442\u043E\u043B\u044C\u043A\u043E \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u044B. \u0417\u0430\u0444\u0438\u043A\u0441\u0438\u0440\u0443\u0439\u0442\u0435 \u0440\u0435\u0436\u0438\u043C: session start --mode sandbox.`
    });
  }
}
function tradingStatusLine(gate) {
  if (gate.stonksMode) {
    return "\u0420\u0435\u0430\u043B\u044C\u043D\u044B\u0435 \u0441\u0434\u0435\u043B\u043A\u0438: STONKS \u2014 \u0432\u044B\u043F\u043E\u043B\u043D\u044F\u044E\u0442\u0441\u044F \u0411\u0415\u0417 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0439.";
  }
  if (gate.allowTrading) {
    return "\u0420\u0435\u0430\u043B\u044C\u043D\u044B\u0435 \u0441\u0434\u0435\u043B\u043A\u0438: \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u044B (\u043A\u0430\u0436\u0434\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430 \u0442\u0440\u0435\u0431\u0443\u0435\u0442 --confirm).";
  }
  return "\u0420\u0435\u0430\u043B\u044C\u043D\u044B\u0435 \u0441\u0434\u0435\u043B\u043A\u0438: \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D\u044B (\u0432 full \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u0435\u043D\u0438\u0435).";
}
function registerSessionCommands(program3) {
  const session = program3.command("session").description("\u0444\u0438\u043A\u0441\u0430\u0446\u0438\u044F \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0433\u043E \u0440\u0435\u0436\u0438\u043C\u0430 \u043D\u0430 \u0441\u0435\u0441\u0441\u0438\u044E (\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u0430 \u043F\u0435\u0440\u0435\u0434 \u043A\u043E\u043C\u0430\u043D\u0434\u0430\u043C\u0438 \u0441 \u0434\u0430\u043D\u043D\u044B\u043C\u0438)");
  session.command("start").description("\u0437\u0430\u0444\u0438\u043A\u0441\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C (\u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E readonly); \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u2014 \u044D\u0442\u043E\u0439 \u0436\u0435 \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 \u0432 \u043B\u044E\u0431\u043E\u0439 \u043C\u043E\u043C\u0435\u043D\u0442").action(
    async (_opts, cmd) => runSessionCommand(cmd, (json) => {
      const { mode: rawMode } = cmd.optsWithGlobals();
      const mode = rawMode ? parseMode(rawMode) : "readonly";
      resolveModeAndToken(process.env, mode);
      const gate = resolveTradingGate(process.env);
      const state = writeActiveMode(activeModeStatePath(process.env), mode, /* @__PURE__ */ new Date());
      if (json) {
        return {
          activeMode: state.mode,
          startedAt: state.startedAt,
          tradingAllowed: gate.allowTrading,
          stonksMode: gate.stonksMode
        };
      }
      const lines = [
        `\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u0437\u0430\u0444\u0438\u043A\u0441\u0438\u0440\u043E\u0432\u0430\u043D: \xAB${state.mode}\xBB. \u041F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u043C\u043E\u0436\u043D\u043E \u0432 \u043B\u044E\u0431\u043E\u0439 \u043C\u043E\u043C\u0435\u043D\u0442: session start --mode <\u0440\u0435\u0436\u0438\u043C>.`
      ];
      if (mode === "full") {
        lines.push(gate.stonksMode ? STONKS_WARNING : tradingStatusLine(gate));
      }
      return lines.join("\n");
    })
  );
  session.command("status").description("\u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C, \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E\u0441\u0442\u044C \u0442\u043E\u043A\u0435\u043D\u043E\u0432 \u0438 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0433\u0435\u0439\u0442\u0430 \u0442\u043E\u0440\u0433\u043E\u0432\u043B\u0438").action(
    async (_opts, cmd) => runSessionCommand(cmd, async (json) => {
      const state = readActiveMode(activeModeStatePath(process.env));
      const tokens = tokenAvailability(process.env);
      const gate = resolveTradingGate(process.env);
      const sessionId = process.env[SESSION_ID_ENV_VAR]?.trim() || null;
      const warning = gate.stonksMode ? STONKS_WARNING : null;
      if (json) {
        return {
          active: state !== null,
          activeMode: state?.mode ?? null,
          startedAt: state?.startedAt ?? null,
          sessionId,
          tokens,
          tradingAllowed: gate.allowTrading,
          stonksMode: gate.stonksMode,
          warning,
          tokenEnvPath: GLOBAL_ENV_PATH
        };
      }
      const tokensLine = Object.entries(tokens).map(([mode, ok]) => `${mode}: ${ok ? "\u2713" : "\u2717 (\u0442\u043E\u043A\u0435\u043D \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D)"}`).join(", ");
      const modeLine = state ? `\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C: \xAB${state.mode}\xBB (\u0437\u0430\u0444\u0438\u043A\u0441\u0438\u0440\u043E\u0432\u0430\u043D ${state.startedAt}).` : "\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u043D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D \u2014 \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \xABsession start\xBB (\u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E readonly).";
      return [
        modeLine,
        `\u0422\u043E\u043A\u0435\u043D\u044B: ${tokensLine}`,
        tradingStatusLine(gate),
        warning,
        `\u0424\u0430\u0439\u043B \u0442\u043E\u043A\u0435\u043D\u043E\u0432: ${GLOBAL_ENV_PATH}`
      ].filter(Boolean).join("\n");
    })
  );
  session.command("end").description("\u0441\u043D\u044F\u0442\u044C \u0444\u0438\u043A\u0441\u0430\u0446\u0438\u044E \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0433\u043E \u0440\u0435\u0436\u0438\u043C\u0430 (\u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u0435\u0442 \u0437\u0430\u043D\u043E\u0432\u043E \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u0440\u0435\u0436\u0438\u043C)").action(
    async (_opts, cmd) => runSessionCommand(cmd, (json) => {
      const removed = clearActiveMode(activeModeStatePath(process.env));
      if (json) {
        return { ended: removed };
      }
      return removed ? "\u0420\u0435\u0436\u0438\u043C \u0441\u0431\u0440\u043E\u0448\u0435\u043D. \u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u043E\u0432\u044B\u0439 \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 \xABsession start\xBB." : "\u0410\u043A\u0442\u0438\u0432\u043D\u043E\u0433\u043E \u0440\u0435\u0436\u0438\u043C\u0430 \u043D\u0435 \u0431\u044B\u043B\u043E.";
    })
  );
  const sandbox = program3.command("sandbox").description("\u0443\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u0435\u0439 (\u0432\u0438\u0440\u0442\u0443\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0447\u0451\u0442)");
  sandbox.command("init").description("\u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0441\u0447\u0451\u0442 \u0432 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u0435 \u0438 \u043F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0435\u0433\u043E \u0440\u0443\u0431\u043B\u044F\u043C\u0438").option("--amount <rub>", "\u0441\u0443\u043C\u043C\u0430 \u043F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F \u0432 \u0440\u0443\u0431\u043B\u044F\u0445", String(DEFAULT_SANDBOX_PAYIN_RUB)).action(
    async (opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      assertSandboxMode(mode, "sandbox init");
      const amount = parsePositiveInt(opts.amount, "--amount", MAX_SANDBOX_PAYIN_RUB);
      const { accountId } = await client.openSandboxAccount();
      const { balance } = await client.sandboxPayIn(accountId, amount);
      return json ? { accountId, balance } : `\u0421\u0447\u0451\u0442 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u044B \u043E\u0442\u043A\u0440\u044B\u0442: ${accountId}
\u0411\u0430\u043B\u0430\u043D\u0441 \u043F\u043E\u0441\u043B\u0435 \u043F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u044F: ${formatMoney(balance)}`;
    })
  );
  sandbox.command("accounts").description("\u0441\u043F\u0438\u0441\u043E\u043A \u0441\u0447\u0435\u0442\u043E\u0432 \u0432 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u0435").action(
    async (_opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      assertSandboxMode(mode, "sandbox accounts");
      const views = buildAccountViews(await client.getSandboxAccounts());
      if (json) {
        return views;
      }
      return views.length > 0 ? renderAccounts(views) : "\u0412 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u0435 \u043D\u0435\u0442 \u0441\u0447\u0435\u0442\u043E\u0432. \u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u0441\u0447\u0451\u0442: sandbox init.";
    })
  );
  sandbox.command("close").description("\u0437\u0430\u043A\u0440\u044B\u0442\u044C \u0441\u0447\u0451\u0442 \u0432 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u0435 (\u0432\u0438\u0440\u0442\u0443\u0430\u043B\u044C\u043D\u044B\u0439; \u0443\u0434\u0430\u043B\u044F\u0435\u0442 \u0441\u0447\u0451\u0442 \u0438 \u0435\u0433\u043E \u043F\u043E\u0437\u0438\u0446\u0438\u0438)").argument("<accountId>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u044B (\u0441\u043C. sandbox accounts)").action(
    async (accountId, _opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      assertSandboxMode(mode, "sandbox close");
      await client.closeSandboxAccount(accountId);
      return json ? { closed: accountId } : `\u0421\u0447\u0451\u0442 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u044B ${accountId} \u0437\u0430\u043A\u0440\u044B\u0442.`;
    })
  );
}

// src/commands/trading/orders.ts
var import_node_crypto = require("node:crypto");

// src/util/audit.ts
var import_node_fs5 = __toESM(require("node:fs"), 1);
var import_node_path7 = __toESM(require("node:path"), 1);
function field(label, value) {
  return value === void 0 || value === null ? null : `${label}=${value}`;
}
function formatAuditLine(e) {
  const head = `${e.action} ${e.ticker ?? "\u2014"}${e.lots != null ? ` x${e.lots}` : ""}`;
  const amount = e.amount != null ? `amount=${e.amount}${e.currency ? ` ${e.currency}` : ""}` : null;
  const parts = [
    e.at,
    e.mode,
    head,
    e.orderType ?? null,
    field("price", e.price),
    amount,
    field("comm", e.commission),
    field("order", e.orderId),
    field("key", e.idempotencyKey),
    e.status ?? null
  ].filter((p) => Boolean(p));
  return parts.join(" | ");
}
function appendTradeAudit(entry, filePath = TRADES_LOG_PATH) {
  try {
    import_node_fs5.default.mkdirSync(import_node_path7.default.dirname(filePath), { recursive: true });
    import_node_fs5.default.appendFileSync(filePath, `${formatAuditLine(entry)}
`, { mode: 384 });
  } catch (err) {
    console.error(
      `\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435: \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0436\u0443\u0440\u043D\u0430\u043B \u0441\u0434\u0435\u043B\u043E\u043A ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// src/commands/trading/paths.ts
var REAL_PATHS = {
  postOrder: "OrdersService/PostOrder",
  cancelOrder: "OrdersService/CancelOrder",
  getOrders: "OrdersService/GetOrders",
  getOrderState: "OrdersService/GetOrderState",
  replaceOrder: "OrdersService/ReplaceOrder",
  getMaxLots: "OrdersService/GetMaxLots",
  getOrderPrice: "OrdersService/GetOrderPrice",
  postStopOrder: "StopOrdersService/PostStopOrder",
  cancelStopOrder: "StopOrdersService/CancelStopOrder",
  getStopOrders: "StopOrdersService/GetStopOrders"
};
var SANDBOX_PATHS = {
  postOrder: "SandboxService/PostSandboxOrder",
  cancelOrder: "SandboxService/CancelSandboxOrder",
  getOrders: "SandboxService/GetSandboxOrders",
  getOrderState: "SandboxService/GetSandboxOrderState",
  replaceOrder: "SandboxService/ReplaceSandboxOrder",
  getMaxLots: "SandboxService/GetSandboxMaxLots",
  getOrderPrice: "SandboxService/GetSandboxOrderPrice",
  postStopOrder: "SandboxService/PostSandboxStopOrder",
  cancelStopOrder: "SandboxService/CancelSandboxStopOrder",
  getStopOrders: "SandboxService/GetSandboxStopOrders"
};
function tradingPathsForMode(mode) {
  return mode === "sandbox" ? SANDBOX_PATHS : REAL_PATHS;
}
function assertMutationAllowed(mode, confirmed, gate) {
  if (mode === "readonly") {
    throw new AppError({
      code: "APP_TINVEST_TRADING_FORBIDDEN",
      userMessage: "\u0422\u043E\u0440\u0433\u043E\u0432\u044B\u0435 \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0438 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 \xAB\u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u0435\u043D\u0438\u0435\xBB. \u0414\u043B\u044F \u0442\u0440\u0435\u043D\u0438\u0440\u043E\u0432\u043A\u0438 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u0443 (sandbox), \u0434\u043B\u044F \u0440\u0435\u0430\u043B\u044C\u043D\u043E\u0439 \u0442\u043E\u0440\u0433\u043E\u0432\u043B\u0438 \u2014 \u0440\u0435\u0436\u0438\u043C full."
    });
  }
  if (mode === "sandbox") {
    return;
  }
  if (!gate.allowTrading) {
    throw new AppError({
      code: "APP_TINVEST_TRADING_DISABLED",
      userMessage: `\u0420\u0435\u0430\u043B\u044C\u043D\u044B\u0435 \u0441\u0434\u0435\u043B\u043A\u0438 \u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D\u044B. \u0421\u0430\u043C\u043E \u043D\u0430\u043B\u0438\u0447\u0438\u0435 full-\u0442\u043E\u043A\u0435\u043D\u0430 \u043D\u0435 \u0434\u0430\u0451\u0442 \u0442\u043E\u0440\u0433\u043E\u0432\u0430\u0442\u044C: \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0438\u0445 \u0444\u043B\u0430\u0433\u043E\u043C ${TRADING_ENABLE_ENV_VAR}=true \u0432 .env (\u0447\u0442\u0435\u043D\u0438\u0435 \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 full \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0438 \u0431\u0435\u0437 \u043D\u0435\u0433\u043E).`
    });
  }
  if (gate.stonksMode) {
    return;
  }
  if (!confirmed) {
    throw new AppError({
      code: "APP_TINVEST_CONFIRM_REQUIRED",
      userMessage: "\u0421\u0434\u0435\u043B\u043A\u0430 \u0440\u0435\u0430\u043B\u044C\u043D\u044B\u043C\u0438 \u0434\u0435\u043D\u044C\u0433\u0430\u043C\u0438 \u0442\u0440\u0435\u0431\u0443\u0435\u0442 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F: \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043A\u043E\u043C\u0430\u043D\u0434\u0443 \u0441 \u0444\u043B\u0430\u0433\u043E\u043C --confirm \u043F\u043E\u0441\u043B\u0435 \u044F\u0432\u043D\u043E\u0433\u043E \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u043D\u0430 \u044D\u0442\u0443 \u0437\u0430\u044F\u0432\u043A\u0443."
    });
  }
}
function assertMarketOrderLiquidity(bestBid, bestAsk, maxSpreadPercent) {
  if (bestBid === null || bestAsk === null || bestBid <= 0 || bestAsk <= 0) {
    throw new AppError({
      code: "APP_TINVEST_ILLIQUID_MARKET",
      userMessage: "\u0420\u044B\u043D\u043E\u0447\u043D\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430 \u043E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u0430: \u0432 \u0441\u0442\u0430\u043A\u0430\u043D\u0435 \u043D\u0435\u0442 \u0434\u0432\u0443\u0441\u0442\u043E\u0440\u043E\u043D\u043D\u0438\u0445 \u043A\u043E\u0442\u0438\u0440\u043E\u0432\u043E\u043A (\u043D\u0438\u0437\u043A\u0430\u044F \u043B\u0438\u043A\u0432\u0438\u0434\u043D\u043E\u0441\u0442\u044C) \u2014 \u0438\u0441\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u043F\u043E \u043B\u044E\u0431\u043E\u0439 \u0446\u0435\u043D\u0435. \u0417\u0430\u0434\u0430\u0439\u0442\u0435 \u043B\u0438\u043C\u0438\u0442\u043D\u0443\u044E \u0446\u0435\u043D\u0443 \u0447\u0435\u0440\u0435\u0437 --price."
    });
  }
  const spreadPercent = (bestAsk - bestBid) / ((bestBid + bestAsk) / 2) * 100;
  if (spreadPercent > maxSpreadPercent) {
    throw new AppError({
      code: "APP_TINVEST_WIDE_SPREAD",
      userMessage: `\u0420\u044B\u043D\u043E\u0447\u043D\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430 \u043E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u0430: \u0441\u043F\u0440\u0435\u0434 \u0432 \u0441\u0442\u0430\u043A\u0430\u043D\u0435 ${spreadPercent.toFixed(2)} % (\u043F\u043E\u0440\u043E\u0433 ${maxSpreadPercent} %) \u2014 \u0440\u044B\u043D\u043E\u0447\u043D\u043E\u0435 \u0438\u0441\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u043D\u0435\u0432\u044B\u0433\u043E\u0434\u043D\u043E. \u0417\u0430\u0434\u0430\u0439\u0442\u0435 \u043B\u0438\u043C\u0438\u0442\u043D\u0443\u044E \u0446\u0435\u043D\u0443 \u0447\u0435\u0440\u0435\u0437 --price.`
    });
  }
}

// src/commands/trading/price-type.ts
function priceTypeFor(instrumentType) {
  return POINT_PRICED_INSTRUMENT_TYPES.includes(instrumentType) ? "PRICE_TYPE_POINT" : "PRICE_TYPE_CURRENCY";
}

// src/commands/trading/pricing-context.ts
var CURRENCY_CONTEXT = { priceUnit: "currency", nominalRub: null };
async function resolvePricingContext(api, instrumentType, uid) {
  const priceUnit = priceUnitFor(instrumentType);
  if (instrumentType !== "bond") {
    return { priceUnit, nominalRub: null };
  }
  try {
    const { instrument } = await api.getBondBy(uid);
    return { priceUnit, nominalRub: moneyToNumberOrNull(instrument.nominal) };
  } catch (err) {
    console.error(
      `\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435: \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043D\u043E\u043C\u0438\u043D\u0430\u043B \u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u0438 ${uid} \u0434\u043B\u044F \u0440\u0443\u0431\u043B\u0451\u0432\u043E\u0433\u043E \u044D\u043A\u0432\u0438\u0432\u0430\u043B\u0435\u043D\u0442\u0430: ${err instanceof Error ? err.message : String(err)}`
    );
    return { priceUnit, nominalRub: null };
  }
}
async function pricingForFigi(api, figi) {
  const info = await resolveLabelByFigi(api, figi);
  if (!info) {
    return CURRENCY_CONTEXT;
  }
  return resolvePricingContext(api, info.instrumentType, info.uid);
}
async function priceUnitsByFigi(api, figis) {
  const unique = [...new Set(figis.filter((f) => Boolean(f)))];
  const byFigi = /* @__PURE__ */ new Map();
  if (unique.length === 0) {
    return byFigi;
  }
  await mapWithConcurrency(
    unique,
    { concurrency: BATCH_CONCURRENCY, minIntervalMs: BATCH_MIN_INTERVAL_MS },
    async (figi) => {
      try {
        const info = await resolveLabelByFigi(api, figi);
        if (info) {
          byFigi.set(figi, priceUnitFor(info.instrumentType));
        }
      } catch (err) {
        console.error(
          `\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435: \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u0435\u0434\u0438\u043D\u0438\u0446\u0443 \u0446\u0435\u043D\u044B \u043F\u043E FIGI ${figi}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return null;
    }
  );
  return byFigi;
}

// src/commands/trading/orders.ts
function announceIdempotencyKey(clientOrderId) {
  console.error(
    `\u041A\u043B\u044E\u0447 \u0438\u0434\u0435\u043C\u043F\u043E\u0442\u0435\u043D\u0442\u043D\u043E\u0441\u0442\u0438 \u0437\u0430\u044F\u0432\u043A\u0438: ${clientOrderId}. \u0414\u043B\u044F \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0433\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u0430 \u0442\u043E\u0439 \u0436\u0435 \u0437\u0430\u044F\u0432\u043A\u0438 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435: --order-id ${clientOrderId}`
  );
}
var ORDER_STATUS_LABELS = {
  EXECUTION_REPORT_STATUS_FILL: "\u0438\u0441\u043F\u043E\u043B\u043D\u0435\u043D\u0430",
  EXECUTION_REPORT_STATUS_PARTIALLYFILL: "\u0438\u0441\u043F\u043E\u043B\u043D\u0435\u043D\u0430 \u0447\u0430\u0441\u0442\u0438\u0447\u043D\u043E",
  EXECUTION_REPORT_STATUS_NEW: "\u0432\u044B\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0430",
  EXECUTION_REPORT_STATUS_REJECTED: "\u043E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u0430",
  EXECUTION_REPORT_STATUS_CANCELLED: "\u043E\u0442\u043C\u0435\u043D\u0435\u043D\u0430"
};
function orderStatusText(status) {
  if (!status) {
    return null;
  }
  return ORDER_STATUS_LABELS[status] ?? status;
}
async function resolveTradeInstrument(api, query) {
  const instrument = await resolveInstrument(api, query, { requireUnambiguous: true });
  if (instrument.apiTradeAvailableFlag === false) {
    throw new AppError({
      code: "APP_TINVEST_NOT_TRADABLE",
      userMessage: `\xAB${instrument.ticker}\xBB (${instrument.name}) \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0434\u043B\u044F \u0442\u043E\u0440\u0433\u043E\u0432\u043B\u0438 \u0447\u0435\u0440\u0435\u0437 API.`
    });
  }
  return instrument;
}
function toPlacedView(resp, base) {
  return {
    orderId: resp.orderId ?? null,
    clientOrderId: base.clientOrderId,
    ticker: base.ticker,
    direction: base.direction,
    orderType: base.orderType,
    statusText: orderStatusText(resp.executionReportStatus),
    lotsRequested: resp.lotsRequested ? Number(resp.lotsRequested) : null,
    lotsExecuted: resp.lotsExecuted ? Number(resp.lotsExecuted) : null,
    totalAmount: moneyToNumberOrNull(resp.totalOrderAmount),
    executedPrice: moneyToNumberOrNull(resp.executedOrderPrice),
    commission: moneyToNumberOrNull(resp.executedCommission),
    currency: resp.totalOrderAmount?.currency ?? null,
    message: resp.message || null,
    priceUnit: base.priceUnit,
    nominalRub: base.nominalRub
  };
}
async function placeOrder(api, params) {
  assertMutationAllowed(params.mode, params.confirm, params.tradingGate);
  const paths = tradingPathsForMode(params.mode);
  const [accountId, instrument] = await Promise.all([
    resolveAccountId(api, params.explicitAccountId),
    resolveTradeInstrument(api, params.query)
  ]);
  const clientOrderId = params.orderId ?? (0, import_node_crypto.randomUUID)();
  const orderType = params.limitPrice !== null ? "limit" : "market";
  if (params.mode === "full" && orderType === "market") {
    const book = await api.call("MarketDataService/GetOrderBook", {
      instrumentId: instrument.uid,
      depth: 1
    });
    assertMarketOrderLiquidity(
      quotationToNumberOrNull(book.bids?.[0]?.price),
      quotationToNumberOrNull(book.asks?.[0]?.price),
      MARKET_ORDER_MAX_SPREAD_PERCENT
    );
  }
  const request = {
    accountId,
    instrumentId: instrument.uid,
    quantity: String(params.lots),
    direction: orderDirectionToApi(params.direction),
    orderType: orderType === "limit" ? "ORDER_TYPE_LIMIT" : "ORDER_TYPE_MARKET",
    orderId: clientOrderId,
    ...params.limitPrice !== null ? { price: numberToQuotation(params.limitPrice), priceType: priceTypeFor(instrument.instrumentType) } : {}
  };
  announceIdempotencyKey(clientOrderId);
  const resp = await api.call(paths.postOrder, request);
  const pricing = await resolvePricingContext(api, instrument.instrumentType, instrument.uid);
  const view = toPlacedView(resp, {
    ticker: instrument.ticker,
    direction: params.direction,
    orderType,
    clientOrderId,
    priceUnit: pricing.priceUnit,
    nominalRub: pricing.nominalRub
  });
  appendTradeAudit({
    at: (/* @__PURE__ */ new Date()).toISOString(),
    mode: params.mode,
    action: params.direction,
    ticker: view.ticker,
    lots: view.lotsRequested,
    orderType,
    price: view.executedPrice,
    amount: view.totalAmount,
    commission: view.commission,
    currency: view.currency,
    orderId: view.orderId,
    idempotencyKey: clientOrderId,
    status: view.statusText
  });
  return view;
}
async function previewOrder(api, params) {
  const paths = tradingPathsForMode(params.mode);
  const [accountId, instrument] = await Promise.all([
    resolveAccountId(api, params.explicitAccountId),
    resolveTradeInstrument(api, params.query)
  ]);
  let priceUsed = params.limitPrice;
  let priceSource = "limit";
  if (priceUsed === null) {
    const { lastPrices } = await api.getLastPrices([instrument.uid]);
    const last = lastPrices.find((p) => p.instrumentUid === instrument.uid)?.price;
    priceUsed = quotationToNumberOrNull(last);
    priceSource = "last-price";
  }
  const maxLots = await api.call(paths.getMaxLots, {
    accountId,
    instrumentId: instrument.uid,
    ...priceUsed !== null ? { price: numberToQuotation(priceUsed) } : {}
  });
  let estimatedAmount = null;
  let commission = null;
  let currency = maxLots.currency ?? null;
  if (priceUsed !== null) {
    const price = await api.call(paths.getOrderPrice, {
      accountId,
      instrumentId: instrument.uid,
      price: numberToQuotation(priceUsed),
      direction: orderDirectionToApi(params.direction),
      quantity: String(params.lots)
    });
    estimatedAmount = moneyToNumberOrNull(price.totalOrderAmount);
    commission = moneyToNumberOrNull(price.executedCommission);
    currency = price.totalOrderAmount?.currency ?? currency;
  }
  const pricing = await resolvePricingContext(api, instrument.instrumentType, instrument.uid);
  return {
    ticker: instrument.ticker,
    name: instrument.name,
    lotSize: instrument.lot ?? null,
    direction: params.direction,
    lots: params.lots,
    priceUsed,
    priceSource,
    estimatedAmount,
    commission,
    currency,
    maxBuyLots: maxLots.buyLimits?.buyMaxLots ? Number(maxLots.buyLimits.buyMaxLots) : null,
    maxSellLots: maxLots.sellLimits?.sellMaxLots ? Number(maxLots.sellLimits.sellMaxLots) : null,
    availableMoney: quotationToNumberOrNull(maxLots.buyLimits?.buyMoneyAmount),
    priceUnit: pricing.priceUnit,
    nominalRub: pricing.nominalRub
  };
}
function toOrderStateView(order, pricing = { priceUnit: "currency", nominalRub: null }) {
  return {
    orderId: order.orderId ?? null,
    ticker: order.ticker ?? order.figi ?? null,
    direction: directionFromApi(order.direction),
    statusText: orderStatusText(order.executionReportStatus),
    lotsRequested: order.lotsRequested ? Number(order.lotsRequested) : null,
    lotsExecuted: order.lotsExecuted ? Number(order.lotsExecuted) : null,
    initialPrice: moneyToNumberOrNull(order.initialSecurityPrice),
    totalAmount: moneyToNumberOrNull(order.totalOrderAmount),
    currency: order.totalOrderAmount?.currency ?? null,
    orderDate: order.orderDate ?? null,
    // Единицу цены берём из валюты самого поля initialSecurityPrice (контуры
    // отдают её в разных единицах: бой — пункты, песочница — рубли); тип
    // инструмента (pricing.priceUnit) — фолбэк, если валюта не пришла.
    priceUnit: priceUnitFromCurrency(order.initialSecurityPrice?.currency) ?? pricing.priceUnit,
    nominalRub: pricing.nominalRub
  };
}
async function listOrders(api, params) {
  const paths = tradingPathsForMode(params.mode);
  const accountId = await resolveAccountId(api, params.explicitAccountId);
  const resp = await api.call(paths.getOrders, { accountId });
  const orders = resp.orders ?? [];
  const units = await priceUnitsByFigi(api, orders.map((o) => o.figi ?? ""));
  return orders.map(
    (o) => toOrderStateView(o, { priceUnit: o.figi && units.get(o.figi) || "currency", nominalRub: null })
  );
}
async function orderStatus(api, params) {
  const paths = tradingPathsForMode(params.mode);
  const accountId = await resolveAccountId(api, params.explicitAccountId);
  const resp = await api.call(paths.getOrderState, {
    accountId,
    orderId: params.orderId
  });
  const pricing = await pricingForFigi(api, resp.figi ?? "");
  return toOrderStateView(resp, pricing);
}
async function cancelOrder(api, params) {
  assertMutationAllowed(params.mode, params.confirm, params.tradingGate);
  const paths = tradingPathsForMode(params.mode);
  const accountId = await resolveAccountId(api, params.explicitAccountId);
  const resp = await api.call(paths.cancelOrder, {
    accountId,
    orderId: params.orderId
  });
  appendTradeAudit({
    at: (/* @__PURE__ */ new Date()).toISOString(),
    mode: params.mode,
    action: "cancel",
    ticker: null,
    // у отмены известен только номер заявки
    orderId: params.orderId,
    status: resp.time ? "\u043E\u0442\u043C\u0435\u043D\u0435\u043D\u0430" : "\u043E\u0442\u043C\u0435\u043D\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0430"
  });
  return { cancelledAt: resp.time ?? null };
}
async function replaceOrder(api, params) {
  assertMutationAllowed(params.mode, params.confirm, params.tradingGate);
  const paths = tradingPathsForMode(params.mode);
  const accountId = await resolveAccountId(api, params.explicitAccountId);
  const state = await api.call(paths.getOrderState, {
    accountId,
    orderId: params.orderId
  });
  const instrument = await resolveLabelByFigi(api, state.figi ?? "");
  if (!instrument) {
    throw new AppError({
      code: "APP_TINVEST_ORDER_INSTRUMENT_UNKNOWN",
      userMessage: `\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0438\u0442\u044C \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442 \u0437\u0430\u044F\u0432\u043A\u0438 ${params.orderId} \u2014 \u0437\u0430\u043C\u0435\u043D\u0430 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u0430, \u0447\u0442\u043E\u0431\u044B \u043D\u0435 \u0432\u044B\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0446\u0435\u043D\u0443 \u043D\u0435\u0432\u0435\u0440\u043D\u043E\u0433\u043E \u0442\u0438\u043F\u0430. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043D\u043E\u043C\u0435\u0440 \u0437\u0430\u044F\u0432\u043A\u0438: order status.`
    });
  }
  const idempotencyKey = params.newOrderId ?? (0, import_node_crypto.randomUUID)();
  announceIdempotencyKey(idempotencyKey);
  const replaceRequest = {
    accountId,
    orderId: params.orderId,
    idempotencyKey,
    quantity: String(params.lots),
    price: numberToQuotation(params.price),
    priceType: priceTypeFor(instrument.instrumentType)
  };
  const resp = await api.call(paths.replaceOrder, replaceRequest);
  const pricing = await resolvePricingContext(api, instrument.instrumentType, instrument.uid);
  const view = toPlacedView(resp, {
    ticker: instrument.ticker,
    // Направление берём из ответа; при отсутствии поля — null, не «покупка».
    direction: directionFromApi(resp.direction),
    orderType: "limit",
    clientOrderId: idempotencyKey,
    priceUnit: pricing.priceUnit,
    nominalRub: pricing.nominalRub
  });
  appendTradeAudit({
    at: (/* @__PURE__ */ new Date()).toISOString(),
    mode: params.mode,
    action: "replace",
    ticker: view.ticker,
    lots: params.lots,
    orderType: "limit",
    price: params.price,
    orderId: view.orderId,
    idempotencyKey,
    status: view.statusText
  });
  return view;
}

// src/commands/trading/orders-render.ts
function placedHeaderDirection(direction) {
  return direction ? `${directionPhrase(direction)} ` : "";
}
function renderPlacedOrder(view) {
  const lines = [
    `\u0417\u0430\u044F\u0432\u043A\u0430 ${placedHeaderDirection(view.direction)}${view.ticker} (${view.orderType === "limit" ? "\u043B\u0438\u043C\u0438\u0442\u043D\u0430\u044F" : "\u0440\u044B\u043D\u043E\u0447\u043D\u0430\u044F"}): ${view.statusText ?? DASH}`,
    `\u041D\u043E\u043C\u0435\u0440: ${view.orderId ?? DASH} | \u043A\u043B\u044E\u0447 \u0438\u0434\u0435\u043C\u043F\u043E\u0442\u0435\u043D\u0442\u043D\u043E\u0441\u0442\u0438: ${view.clientOrderId} | \u043B\u043E\u0442\u043E\u0432: ${view.lotsExecuted ?? 0}/${view.lotsRequested ?? DASH}`,
    // Сумма помечается единицей из ответа API: у ещё не исполненной заявки по
    // облигации приходит в пунктах (currency "pt."), у исполненной — в рублях.
    `\u0421\u0443\u043C\u043C\u0430: ${view.totalAmount !== null ? formatMoneyAmount(view.totalAmount, view.currency) : DASH}` + (view.commission !== null ? ` | \u043A\u043E\u043C\u0438\u0441\u0441\u0438\u044F: ${formatMoneyAmount(view.commission, view.currency)}` : "")
  ];
  if (view.message) {
    lines.push(`\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0431\u0440\u043E\u043A\u0435\u0440\u0430: ${view.message}`);
  }
  return lines.join("\n");
}
function renderOrderPreview(view) {
  const priceText = view.priceUsed !== null ? formatInstrumentPrice(view.priceUsed, {
    unit: view.priceUnit,
    nominalRub: view.nominalRub,
    currency: view.currency
  }) : DASH;
  const lines = [
    `\u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440: ${directionLabel(view.direction)} ${view.ticker} (${view.name}), \u043B\u043E\u0442\u043E\u0432: ${view.lots}` + (view.lotSize !== null ? ` (\u0432 \u043B\u043E\u0442\u0435 ${view.lotSize} \u0448\u0442.)` : ""),
    `\u0426\u0435\u043D\u0430 \u0434\u043B\u044F \u043E\u0446\u0435\u043D\u043A\u0438: ${priceText} (${view.priceSource === "limit" ? "\u043B\u0438\u043C\u0438\u0442\u043D\u0430\u044F" : "\u043F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u0440\u044B\u043D\u043E\u0447\u043D\u0430\u044F"})`,
    `\u041E\u0446\u0435\u043D\u043A\u0430 \u0441\u0443\u043C\u043C\u044B: ${view.estimatedAmount !== null ? formatMoneyAmount(view.estimatedAmount, view.currency) : DASH}` + (view.commission !== null ? ` | \u043A\u043E\u043C\u0438\u0441\u0441\u0438\u044F: ${formatMoneyAmount(view.commission, view.currency)}` : ""),
    `\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E: \u043F\u043E\u043A\u0443\u043F\u043A\u0430 \u0434\u043E ${view.maxBuyLots ?? DASH} \u043B\u043E\u0442\u043E\u0432 | \u043F\u0440\u043E\u0434\u0430\u0436\u0430 \u0434\u043E ${view.maxSellLots ?? DASH} \u043B\u043E\u0442\u043E\u0432` + (view.availableMoney !== null ? ` | \u0441\u0432\u043E\u0431\u043E\u0434\u043D\u043E ${formatMoneyAmount(view.availableMoney, view.currency)}` : "")
  ];
  if (view.priceUnit === "point") {
    lines.push(
      "\u041F\u0440\u0438\u043C\u0435\u0447\u0430\u043D\u0438\u0435: \u043E\u0446\u0435\u043D\u043A\u0430 \u0441\u0443\u043C\u043C\u044B \u043E\u0442 API \u043F\u043E \u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u044F\u043C/\u0444\u044C\u044E\u0447\u0435\u0440\u0441\u0430\u043C \u0437\u0430\u043D\u0438\u0436\u0435\u043D\u0430 (\u0441\u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F \u0431\u0435\u0437 \u043D\u043E\u043C\u0438\u043D\u0430\u043B\u0430) \u2014 \u043E\u0440\u0438\u0435\u043D\u0442\u0438\u0440\u0443\u0439\u0442\u0435\u0441\u044C \u043D\u0430 \u0446\u0435\u043D\u0443 \u0432\u044B\u0448\u0435 \u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0439\u0442\u0435 \u0444\u0430\u043A\u0442\u0438\u0447\u0435\u0441\u043A\u043E\u0435 \u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0447\u0435\u0440\u0435\u0437 portfolio/operations."
    );
  }
  return lines.join("\n");
}
function renderOrders(views) {
  if (views.length === 0) {
    return "\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0445 \u0437\u0430\u044F\u0432\u043E\u043A \u043D\u0435\u0442.";
  }
  return renderTable(
    ["\u041D\u043E\u043C\u0435\u0440", "\u0422\u0438\u043A\u0435\u0440", "\u041D\u0430\u043F\u0440.", "\u0421\u0442\u0430\u0442\u0443\u0441", "\u041B\u043E\u0442\u044B", "\u0426\u0435\u043D\u0430", "\u0421\u0443\u043C\u043C\u0430"],
    views.map((v) => [
      v.orderId ?? DASH,
      v.ticker ?? DASH,
      directionLabel(v.direction),
      v.statusText ?? DASH,
      `${v.lotsExecuted ?? 0}/${v.lotsRequested ?? DASH}`,
      // В таблице цена помечается единицей, но без ₽-эквивалента (nominalRub не
      // тянем на список) — компактно: «100.50 пт» для облигации, «300.50 ₽» для акции.
      v.initialPrice !== null ? formatInstrumentPrice(v.initialPrice, { unit: v.priceUnit, nominalRub: null, currency: v.currency }) : DASH,
      v.totalAmount !== null ? formatMoneyAmount(v.totalAmount, v.currency) : DASH
    ])
  );
}
function renderOrderState(view) {
  const priceText = view.initialPrice !== null ? formatInstrumentPrice(view.initialPrice, {
    unit: view.priceUnit,
    nominalRub: view.nominalRub,
    currency: view.currency
  }) : DASH;
  return [
    `\u0417\u0430\u044F\u0432\u043A\u0430 ${view.orderId ?? DASH}: ${view.statusText ?? DASH}`,
    `${view.ticker ?? DASH} | ${directionLabel(view.direction)} | \u043B\u043E\u0442\u043E\u0432 ${view.lotsExecuted ?? 0}/${view.lotsRequested ?? DASH}`,
    `\u0426\u0435\u043D\u0430: ${priceText} | \u0441\u0443\u043C\u043C\u0430: ${view.totalAmount !== null ? formatMoneyAmount(view.totalAmount, view.currency) : DASH}`
  ].join("\n");
}

// src/commands/trading/stop-orders.ts
var import_node_crypto2 = require("node:crypto");
var STOP_TYPE_BY_KIND = {
  "take-profit": "STOP_ORDER_TYPE_TAKE_PROFIT",
  "stop-loss": "STOP_ORDER_TYPE_STOP_LOSS",
  "stop-limit": "STOP_ORDER_TYPE_STOP_LIMIT"
};
async function placeStopOrder(api, params) {
  assertMutationAllowed(params.mode, params.confirm, params.tradingGate);
  if (params.kind === "stop-limit" && params.limitPrice === null) {
    throw new AppError({
      code: "APP_CLI_INVALID_ARGUMENT",
      userMessage: "\u0414\u043B\u044F \u0441\u0442\u043E\u043F-\u043B\u0438\u043C\u0438\u0442\u0430 \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u043B\u0438\u043C\u0438\u0442\u043D\u0443\u044E \u0446\u0435\u043D\u0443: --price <\u0446\u0435\u043D\u0430>."
    });
  }
  const paths = tradingPathsForMode(params.mode);
  const [accountId, instrument] = await Promise.all([
    resolveAccountId(api, params.explicitAccountId),
    resolveTradeInstrument(api, params.query)
  ]);
  const clientOrderId = params.orderId ?? (0, import_node_crypto2.randomUUID)();
  const request = {
    accountId,
    instrumentId: instrument.uid,
    quantity: String(params.lots),
    direction: stopDirectionToApi(params.direction),
    stopOrderType: STOP_TYPE_BY_KIND[params.kind],
    expirationType: "STOP_ORDER_EXPIRATION_TYPE_GOOD_TILL_CANCEL",
    stopPrice: numberToQuotation(params.stopPrice),
    priceType: priceTypeFor(instrument.instrumentType),
    ...params.limitPrice !== null ? { price: numberToQuotation(params.limitPrice) } : {},
    orderId: clientOrderId
  };
  console.error(
    `\u041A\u043B\u044E\u0447 \u0438\u0434\u0435\u043C\u043F\u043E\u0442\u0435\u043D\u0442\u043D\u043E\u0441\u0442\u0438 \u0441\u0442\u043E\u043F-\u0437\u0430\u044F\u0432\u043A\u0438: ${clientOrderId}. \u0414\u043B\u044F \u043F\u043E\u0432\u0442\u043E\u0440\u0430: --order-id ${clientOrderId}`
  );
  const resp = await api.call(paths.postStopOrder, request);
  const pricing = await resolvePricingContext(api, instrument.instrumentType, instrument.uid);
  const view = {
    stopOrderId: resp.stopOrderId ?? null,
    ticker: instrument.ticker,
    kind: params.kind,
    direction: params.direction,
    lots: params.lots,
    stopPrice: params.stopPrice,
    limitPrice: params.limitPrice,
    priceUnit: pricing.priceUnit,
    nominalRub: pricing.nominalRub
  };
  appendTradeAudit({
    at: (/* @__PURE__ */ new Date()).toISOString(),
    mode: params.mode,
    action: `stop-set:${params.kind}`,
    ticker: view.ticker,
    lots: view.lots,
    orderType: params.direction,
    price: view.stopPrice,
    orderId: view.stopOrderId,
    idempotencyKey: clientOrderId,
    status: "\u0432\u044B\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0430"
  });
  return view;
}
function toStopOrderView(info, pricing = { priceUnit: "currency" }) {
  const limit = moneyToNumberOrNull(info.price);
  return {
    stopOrderId: info.stopOrderId ?? null,
    ticker: info.figi ?? info.instrumentUid ?? null,
    direction: directionFromApi(info.direction),
    lots: info.lotsRequested ? Number(info.lotsRequested) : null,
    stopPrice: moneyToNumberOrNull(info.stopPrice),
    limitPrice: limit !== null && limit !== 0 ? limit : null,
    createDate: info.createDate ?? null,
    status: info.status ?? null,
    // Единицу берём из валюты самого поля stopPrice (бой — пункты, песочница —
    // рубли); тип инструмента (pricing.priceUnit) — фолбэк при отсутствии валюты.
    priceUnit: priceUnitFromCurrency(info.stopPrice?.currency) ?? pricing.priceUnit,
    currency: info.stopPrice?.currency ?? null
  };
}
async function listStopOrders(api, params) {
  const paths = tradingPathsForMode(params.mode);
  const accountId = await resolveAccountId(api, params.explicitAccountId);
  const resp = await api.call(paths.getStopOrders, { accountId });
  const infos = resp.stopOrders ?? [];
  const uniqueFigis = [...new Set(infos.map((i) => i.figi).filter((f) => Boolean(f)))];
  const metaByFigi = /* @__PURE__ */ new Map();
  if (uniqueFigis.length > 0) {
    await mapWithConcurrency(
      uniqueFigis,
      { concurrency: BATCH_CONCURRENCY, minIntervalMs: BATCH_MIN_INTERVAL_MS },
      async (figi) => {
        try {
          const label = await resolveLabelByFigi(api, figi);
          if (label) {
            metaByFigi.set(figi, { ticker: label.ticker, priceUnit: priceUnitFor(label.instrumentType) });
          }
        } catch (err) {
          console.error(
            `\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435: \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0442\u0438\u043A\u0435\u0440/\u0435\u0434\u0438\u043D\u0438\u0446\u0443 \u0446\u0435\u043D\u044B \u043F\u043E FIGI ${figi}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return null;
      }
    );
  }
  return infos.map((info) => {
    const meta = info.figi ? metaByFigi.get(info.figi) : void 0;
    const view = toStopOrderView(info, { priceUnit: meta?.priceUnit ?? "currency" });
    return meta ? { ...view, ticker: meta.ticker } : view;
  });
}
async function cancelStopOrder(api, params) {
  assertMutationAllowed(params.mode, params.confirm, params.tradingGate);
  const paths = tradingPathsForMode(params.mode);
  const accountId = await resolveAccountId(api, params.explicitAccountId);
  const resp = await api.call(paths.cancelStopOrder, {
    accountId,
    stopOrderId: params.stopOrderId
  });
  appendTradeAudit({
    at: (/* @__PURE__ */ new Date()).toISOString(),
    mode: params.mode,
    action: "stop-cancel",
    ticker: null,
    orderId: params.stopOrderId,
    status: resp.time ? "\u043E\u0442\u043C\u0435\u043D\u0435\u043D\u0430" : "\u043E\u0442\u043C\u0435\u043D\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0430"
  });
  return { cancelledAt: resp.time ?? null };
}
function renderPlacedStopOrder(view) {
  const kindLabels = {
    "take-profit": "\u0442\u0435\u0439\u043A-\u043F\u0440\u043E\u0444\u0438\u0442",
    "stop-loss": "\u0441\u0442\u043E\u043F-\u043B\u043E\u0441\u0441",
    "stop-limit": "\u0441\u0442\u043E\u043F-\u043B\u0438\u043C\u0438\u0442"
  };
  const priceOpts = { unit: view.priceUnit, nominalRub: view.nominalRub, currency: null };
  return [
    `\u0421\u0442\u043E\u043F-\u0437\u0430\u044F\u0432\u043A\u0430 (${kindLabels[view.kind]}) \u043F\u043E ${view.ticker} \u0432\u044B\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0430: ${view.stopOrderId ?? DASH}`,
    `${directionLabel(view.direction)} ${view.lots} \u043B\u043E\u0442(\u043E\u0432) \u043F\u0440\u0438 \u0446\u0435\u043D\u0435 ${formatInstrumentPrice(view.stopPrice, priceOpts)}` + (view.limitPrice !== null ? `, \u043B\u0438\u043C\u0438\u0442 ${formatInstrumentPrice(view.limitPrice, priceOpts)}` : "")
  ].join("\n");
}
function renderStopOrders(views) {
  if (views.length === 0) {
    return "\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0445 \u0441\u0442\u043E\u043F-\u0437\u0430\u044F\u0432\u043E\u043A \u043D\u0435\u0442.";
  }
  return renderTable(
    ["\u041D\u043E\u043C\u0435\u0440", "\u0411\u0443\u043C\u0430\u0433\u0430", "\u041D\u0430\u043F\u0440.", "\u041B\u043E\u0442\u044B", "\u0421\u0442\u043E\u043F-\u0446\u0435\u043D\u0430", "\u041B\u0438\u043C\u0438\u0442", "\u0421\u043E\u0437\u0434\u0430\u043D\u0430"],
    views.map((v) => [
      v.stopOrderId ?? DASH,
      v.ticker ?? DASH,
      directionLabel(v.direction),
      v.lots !== null ? String(v.lots) : DASH,
      // В таблице — метка единицы без ₽-эквивалента (nominalRub не тянем на список):
      // «пт» в бою, символ валюты — в песочнице (где цена приходит в рублях).
      v.stopPrice !== null ? formatInstrumentPrice(v.stopPrice, { unit: v.priceUnit, nominalRub: null, currency: v.currency }) : DASH,
      v.limitPrice !== null ? formatInstrumentPrice(v.limitPrice, { unit: v.priceUnit, nominalRub: null, currency: v.currency }) : DASH,
      // Дата создания — в МСК (createDate приходит в UTC).
      v.createDate ? formatMoscowDate(v.createDate) : DASH
    ])
  );
}

// src/cli/register-trading.ts
function parseDirection(raw) {
  if (raw === "buy" || raw === "sell") {
    return raw;
  }
  throw new AppError({
    code: "APP_CLI_INVALID_ARGUMENT",
    userMessage: `\u041F\u0430\u0440\u0430\u043C\u0435\u0442\u0440 --direction \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u0442 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u044F buy | sell; \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E \xAB${raw}\xBB.`
  });
}
function parseStopKind(raw) {
  if (raw === "take-profit" || raw === "stop-loss" || raw === "stop-limit") {
    return raw;
  }
  throw new AppError({
    code: "APP_CLI_INVALID_ARGUMENT",
    userMessage: `\u041F\u0430\u0440\u0430\u043C\u0435\u0442\u0440 --type \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u0442 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u044F take-profit | stop-loss | stop-limit; \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E \xAB${raw}\xBB.`
  });
}
function registerPlaceCommand(order, direction) {
  order.command(direction).description(`${direction === "buy" ? "\u043A\u0443\u043F\u0438\u0442\u044C" : "\u043F\u0440\u043E\u0434\u0430\u0442\u044C"}: \u0440\u044B\u043D\u043E\u0447\u043D\u0430\u044F (\u0431\u0435\u0437 --price) \u0438\u043B\u0438 \u043B\u0438\u043C\u0438\u0442\u043D\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430`).argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430").requiredOption("-q, --lots <n>", "\u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u041B\u041E\u0422\u041E\u0412 (\u0441\u043C. \u0440\u0430\u0437\u043C\u0435\u0440 \u043B\u043E\u0442\u0430 \u0432 order preview)").option(
    "--price <price>",
    "\u043B\u0438\u043C\u0438\u0442\u043D\u0430\u044F \u0446\u0435\u043D\u0430 (\u0431\u0435\u0437 \u043D\u0435\u0451 \u2014 \u0440\u044B\u043D\u043E\u0447\u043D\u0430\u044F \u0437\u0430\u044F\u0432\u043A\u0430); \u0434\u043B\u044F \u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u0439 \u0438 \u0444\u044C\u044E\u0447\u0435\u0440\u0441\u043E\u0432 \u2014 \u0432 \u043F\u0443\u043D\u043A\u0442\u0430\u0445 (% \u043D\u043E\u043C\u0438\u043D\u0430\u043B\u0430)"
  ).option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430").option("--confirm", "\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u0441\u0434\u0435\u043B\u043A\u0438 \u0440\u0435\u0430\u043B\u044C\u043D\u044B\u043C\u0438 \u0434\u0435\u043D\u044C\u0433\u0430\u043C\u0438 (\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u0435\u043D \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 full)").option("--order-id <id>", "\u0441\u0432\u043E\u0439 \u043A\u043B\u044E\u0447 \u0438\u0434\u0435\u043C\u043F\u043E\u0442\u0435\u043D\u0442\u043D\u043E\u0441\u0442\u0438 (\u043F\u043E\u0432\u0442\u043E\u0440 \u0442\u043E\u0439 \u0436\u0435 \u0437\u0430\u044F\u0432\u043A\u0438 \u043D\u0435 \u043F\u0440\u043E\u0434\u0443\u0431\u043B\u0438\u0440\u0443\u0435\u0442 \u0435\u0451)").action(
    async (query, opts, cmd) => runCommand(cmd, async (client, json, mode, tradingGate) => {
      const view = await placeOrder(client, {
        mode,
        explicitAccountId: opts.account,
        query,
        lots: parsePositiveInt(opts.lots, "--lots"),
        direction,
        limitPrice: opts.price !== void 0 ? parsePositiveNumber(opts.price, "--price") : null,
        orderId: opts.orderId,
        confirm: Boolean(opts.confirm),
        tradingGate
      });
      return json ? view : renderPlacedOrder(view);
    })
  );
}
function registerTradingCommands(program3) {
  const order = program3.command("order").description("\u0442\u043E\u0440\u0433\u043E\u0432\u044B\u0435 \u0437\u0430\u044F\u0432\u043A\u0438 (\u043F\u0435\u0441\u043E\u0447\u043D\u0438\u0446\u0430/\u0431\u043E\u0435\u0432\u043E\u0439; \u0432 full \u043C\u0443\u0442\u0430\u0446\u0438\u0438 \u0442\u0440\u0435\u0431\u0443\u044E\u0442 --confirm)");
  order.command("preview").description("\u043F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440: \u043E\u0446\u0435\u043D\u043A\u0430 \u0441\u0443\u043C\u043C\u044B, \u043A\u043E\u043C\u0438\u0441\u0441\u0438\u044F, \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0435 \u043B\u043E\u0442\u044B (\u0431\u0435\u0437 \u0432\u044B\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u0438\u044F)").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430").requiredOption("-q, --lots <n>", "\u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u043B\u043E\u0442\u043E\u0432").option(
    "--price <price>",
    "\u043B\u0438\u043C\u0438\u0442\u043D\u0430\u044F \u0446\u0435\u043D\u0430 (\u0431\u0435\u0437 \u043D\u0435\u0451 \u2014 \u043E\u0446\u0435\u043D\u043A\u0430 \u043F\u043E \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0439 \u0440\u044B\u043D\u043E\u0447\u043D\u043E\u0439); \u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u0438/\u0444\u044C\u044E\u0447\u0435\u0440\u0441\u044B \u2014 \u0432 \u043F\u0443\u043D\u043A\u0442\u0430\u0445 (% \u043D\u043E\u043C\u0438\u043D\u0430\u043B\u0430)"
  ).option("--direction <dir>", "\u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435: buy | sell", "buy").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430").action(
    async (query, opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      const view = await previewOrder(client, {
        mode,
        explicitAccountId: opts.account,
        query,
        lots: parsePositiveInt(opts.lots, "--lots"),
        direction: parseDirection(opts.direction),
        limitPrice: opts.price !== void 0 ? parsePositiveNumber(opts.price, "--price") : null
      });
      return json ? view : renderOrderPreview(view);
    })
  );
  registerPlaceCommand(order, "buy");
  registerPlaceCommand(order, "sell");
  order.command("list").description("\u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0435 \u0437\u0430\u044F\u0432\u043A\u0438 \u043F\u043E \u0441\u0447\u0451\u0442\u0443").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430").action(
    async (opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      const views = await listOrders(client, { mode, explicitAccountId: opts.account });
      return json ? views : renderOrders(views);
    })
  );
  order.command("status").description("\u0441\u0442\u0430\u0442\u0443\u0441 \u0437\u0430\u044F\u0432\u043A\u0438 \u043F\u043E \u043D\u043E\u043C\u0435\u0440\u0443").argument("<orderId>", "\u043D\u043E\u043C\u0435\u0440 \u0437\u0430\u044F\u0432\u043A\u0438").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430").action(
    async (orderId, opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      const view = await orderStatus(client, { mode, explicitAccountId: opts.account, orderId });
      return json ? view : renderOrderState(view);
    })
  );
  order.command("cancel").description("\u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C \u0437\u0430\u044F\u0432\u043A\u0443").argument("<orderId>", "\u043D\u043E\u043C\u0435\u0440 \u0437\u0430\u044F\u0432\u043A\u0438").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430").option("--confirm", "\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 (\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u0435\u043D \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 full)").action(
    async (orderId, opts, cmd) => runCommand(cmd, async (client, json, mode, tradingGate) => {
      const result = await cancelOrder(client, {
        mode,
        explicitAccountId: opts.account,
        orderId,
        confirm: Boolean(opts.confirm),
        tradingGate
      });
      return json ? result : `\u0417\u0430\u044F\u0432\u043A\u0430 ${orderId} \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u0430${result.cancelledAt ? ` (${result.cancelledAt})` : ""}.`;
    })
  );
  order.command("replace").description("\u0437\u0430\u043C\u0435\u043D\u0438\u0442\u044C \u043B\u0438\u043C\u0438\u0442\u043D\u0443\u044E \u0437\u0430\u044F\u0432\u043A\u0443: \u043D\u043E\u0432\u044B\u0435 \u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u0438 \u0446\u0435\u043D\u0430").argument("<orderId>", "\u043D\u043E\u043C\u0435\u0440 \u0437\u0430\u043C\u0435\u043D\u044F\u0435\u043C\u043E\u0439 \u0437\u0430\u044F\u0432\u043A\u0438").requiredOption("-q, --lots <n>", "\u043D\u043E\u0432\u043E\u0435 \u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u043B\u043E\u0442\u043E\u0432").requiredOption("--price <price>", "\u043D\u043E\u0432\u0430\u044F \u043B\u0438\u043C\u0438\u0442\u043D\u0430\u044F \u0446\u0435\u043D\u0430 (\u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u0438/\u0444\u044C\u044E\u0447\u0435\u0440\u0441\u044B \u2014 \u0432 \u043F\u0443\u043D\u043A\u0442\u0430\u0445, % \u043D\u043E\u043C\u0438\u043D\u0430\u043B\u0430)").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430").option("--confirm", "\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 (\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u0435\u043D \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 full)").option("--order-id <id>", "\u0441\u0432\u043E\u0439 \u043A\u043B\u044E\u0447 \u0438\u0434\u0435\u043C\u043F\u043E\u0442\u0435\u043D\u0442\u043D\u043E\u0441\u0442\u0438 \u0437\u0430\u043C\u0435\u043D\u044B (\u0434\u043B\u044F \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0433\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u0430)").action(
    async (orderId, opts, cmd) => runCommand(cmd, async (client, json, mode, tradingGate) => {
      const view = await replaceOrder(client, {
        mode,
        explicitAccountId: opts.account,
        orderId,
        lots: parsePositiveInt(opts.lots, "--lots"),
        price: parsePositiveNumber(opts.price, "--price"),
        newOrderId: opts.orderId,
        confirm: Boolean(opts.confirm),
        tradingGate
      });
      return json ? view : renderPlacedOrder(view);
    })
  );
  const stopOrder = program3.command("stop-order").description("\u0441\u0442\u043E\u043F-\u0437\u0430\u044F\u0432\u043A\u0438: \u0442\u0435\u0439\u043A-\u043F\u0440\u043E\u0444\u0438\u0442, \u0441\u0442\u043E\u043F-\u043B\u043E\u0441\u0441, \u0441\u0442\u043E\u043F-\u043B\u0438\u043C\u0438\u0442");
  stopOrder.command("set").description("\u0432\u044B\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0441\u0442\u043E\u043F-\u0437\u0430\u044F\u0432\u043A\u0443 (\u0431\u0435\u0441\u0441\u0440\u043E\u0447\u043D\u0443\u044E, \u0434\u043E \u043E\u0442\u043C\u0435\u043D\u044B)").argument("<query>", "\u0442\u0438\u043A\u0435\u0440 \u0438\u043B\u0438 ISIN \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u0430").requiredOption("-q, --lots <n>", "\u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u043B\u043E\u0442\u043E\u0432").requiredOption("--type <kind>", "\u0442\u0438\u043F: take-profit | stop-loss | stop-limit").requiredOption("--stop-price <price>", "\u0446\u0435\u043D\u0430 \u0430\u043A\u0442\u0438\u0432\u0430\u0446\u0438\u0438 (\u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u0438/\u0444\u044C\u044E\u0447\u0435\u0440\u0441\u044B \u2014 \u0432 \u043F\u0443\u043D\u043A\u0442\u0430\u0445, % \u043D\u043E\u043C\u0438\u043D\u0430\u043B\u0430)").option(
    "--price <price>",
    "\u043B\u0438\u043C\u0438\u0442\u043D\u0430\u044F \u0446\u0435\u043D\u0430 \u043F\u043E\u0441\u043B\u0435 \u0430\u043A\u0442\u0438\u0432\u0430\u0446\u0438\u0438 (\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u0430 \u0434\u043B\u044F stop-limit; \u043E\u0431\u043B\u0438\u0433\u0430\u0446\u0438\u0438/\u0444\u044C\u044E\u0447\u0435\u0440\u0441\u044B \u2014 \u0432 \u043F\u0443\u043D\u043A\u0442\u0430\u0445)"
  ).option("--direction <dir>", "\u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435: buy | sell", "sell").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430").option("--confirm", "\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 (\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u0435\u043D \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 full)").option("--order-id <id>", "\u0441\u0432\u043E\u0439 \u043A\u043B\u044E\u0447 \u0438\u0434\u0435\u043C\u043F\u043E\u0442\u0435\u043D\u0442\u043D\u043E\u0441\u0442\u0438 (\u0434\u043B\u044F \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0433\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u0430)").action(
    async (query, opts, cmd) => runCommand(cmd, async (client, json, mode, tradingGate) => {
      const view = await placeStopOrder(client, {
        mode,
        explicitAccountId: opts.account,
        query,
        lots: parsePositiveInt(opts.lots, "--lots"),
        kind: parseStopKind(opts.type),
        direction: parseDirection(opts.direction),
        stopPrice: parsePositiveNumber(opts.stopPrice, "--stop-price"),
        limitPrice: opts.price !== void 0 ? parsePositiveNumber(opts.price, "--price") : null,
        orderId: opts.orderId,
        confirm: Boolean(opts.confirm),
        tradingGate
      });
      return json ? view : renderPlacedStopOrder(view);
    })
  );
  stopOrder.command("list").description("\u0430\u043A\u0442\u0438\u0432\u043D\u044B\u0435 \u0441\u0442\u043E\u043F-\u0437\u0430\u044F\u0432\u043A\u0438 \u043F\u043E \u0441\u0447\u0451\u0442\u0443").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430").action(
    async (opts, cmd) => runCommand(cmd, async (client, json, mode) => {
      const views = await listStopOrders(client, { mode, explicitAccountId: opts.account });
      return json ? views : renderStopOrders(views);
    })
  );
  stopOrder.command("cancel").description("\u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C \u0441\u0442\u043E\u043F-\u0437\u0430\u044F\u0432\u043A\u0443").argument("<stopOrderId>", "\u043D\u043E\u043C\u0435\u0440 \u0441\u0442\u043E\u043F-\u0437\u0430\u044F\u0432\u043A\u0438").option("-a, --account <id>", "\u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u043E\u0440 \u0441\u0447\u0451\u0442\u0430").option("--confirm", "\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 (\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u0435\u043D \u0432 \u0440\u0435\u0436\u0438\u043C\u0435 full)").action(
    async (stopOrderId, opts, cmd) => runCommand(cmd, async (client, json, mode, tradingGate) => {
      const result = await cancelStopOrder(client, {
        mode,
        explicitAccountId: opts.account,
        stopOrderId,
        confirm: Boolean(opts.confirm),
        tradingGate
      });
      return json ? result : `\u0421\u0442\u043E\u043F-\u0437\u0430\u044F\u0432\u043A\u0430 ${stopOrderId} \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u0430${result.cancelledAt ? ` (${result.cancelledAt})` : ""}.`;
    })
  );
}

// src/cli.ts
bootstrapEnv();
var program2 = new Command();
program2.name("tinvest").description("CLI \u0434\u043B\u044F \u0422-\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0439 (T-Invest API): \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044C, \u043A\u043E\u0442\u0438\u0440\u043E\u0432\u043A\u0438, \u043F\u043E\u0438\u0441\u043A, \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0438").version(APP_VERSION).option("--json", "\u0432\u044B\u0432\u043E\u0434 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 JSON (\u0434\u043B\u044F \u0438\u043D\u0442\u0435\u0433\u0440\u0430\u0446\u0438\u0439 \u0438 \u0441\u043A\u0438\u043B\u043B\u0430)").option(
  "-m, --mode <mode>",
  "\u0440\u0435\u0436\u0438\u043C: sandbox | readonly | full (\u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E \u2014 \u043F\u043E \u0435\u0434\u0438\u043D\u0441\u0442\u0432\u0435\u043D\u043D\u043E\u043C\u0443 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u043E\u043C\u0443 \u0442\u043E\u043A\u0435\u043D\u0443)"
);
registerCoreCommands(program2);
registerAnalyticsCommands(program2);
registerMarketCommands(program2);
registerInfoCommands(program2);
registerScreenCommands(program2);
registerTradingCommands(program2);
registerSessionCommands(program2);
program2.parseAsync(process.argv).catch(printErrorAndExit);
