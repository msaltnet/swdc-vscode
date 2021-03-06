// Copyright (c) 2018 Software. All Rights Reserved.

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { window, ExtensionContext, StatusBarAlignment, commands } from "vscode";
import {
    isLoggedIn,
    sendHeartbeat,
    initializePreferences,
} from "./DataController";
import { onboardInit } from "./user/OnboardManager";
import {
    showStatus,
    nowInSecs,
    getOffsetSeconds,
    getVersion,
    logIt,
    getPluginName,
    getItem,
    displayReadmeIfNotExists,
    setItem,
} from "./Util";
import { manageLiveshareSession } from "./LiveshareManager";
import { getApi } from "vsls";
import { createCommands } from "./command-helper";
import { KpmManager } from "./managers/KpmManager";
import { SummaryManager } from "./managers/SummaryManager";
import { PluginDataManager } from "./managers/PluginDataManager";
import {
    setSessionSummaryLiveshareMinutes,
    updateStatusBarWithSummaryData,
} from "./storage/SessionSummaryData";
import { WallClockManager } from "./managers/WallClockManager";
import { getLastSavedKeystrokesStats } from "./managers/FileManager";
import { TrackerManager } from "./managers/TrackerManager";

let TELEMETRY_ON = true;
let statusBarItem = null;
let _ls = null;

let fifteen_minute_interval = null;
let twenty_minute_interval = null;
let thirty_minute_interval = null;
let hourly_interval = null;
let liveshare_update_interval = null;

const one_min_millis = 1000 * 60;
const thirty_min_millis = one_min_millis * 30;
const one_hour_millis = one_min_millis * 60;

const tracker: TrackerManager = TrackerManager.getInstance();

//
// Add the keystroke controller to the ext ctx, which
// will then listen for text document changes.
//
const kpmController: KpmManager = KpmManager.getInstance();

export function isTelemetryOn() {
    return TELEMETRY_ON;
}

export function getStatusBarItem() {
    return statusBarItem;
}

export function deactivate(ctx: ExtensionContext) {
    // Process this window's keystroke data since the window has become unfocused/deactivated
    commands.executeCommand("codetime.processKeystrokeData");

    // store the deactivate event
    tracker.trackEditorAction("editor", "deactivate");

    if (_ls && _ls.id) {
        // the IDE is closing, send this off
        let nowSec = nowInSecs();
        let offsetSec = getOffsetSeconds();
        let localNow = nowSec - offsetSec;
        // close the session on our end
        _ls["end"] = nowSec;
        _ls["local_end"] = localNow;
        manageLiveshareSession(_ls);
        _ls = null;
    }

    // dispose the new day timer
    PluginDataManager.getInstance().dispose();
    WallClockManager.getInstance().dispose();

    clearInterval(fifteen_minute_interval);
    clearInterval(twenty_minute_interval);
    clearInterval(thirty_minute_interval);
    clearInterval(hourly_interval);
    clearInterval(liveshare_update_interval);

    // softwareDelete(`/integrations/${PLUGIN_ID}`, getItem("jwt")).then(resp => {
    //     if (isResponseOk(resp)) {
    //         if (resp.data) {
    //             console.log(`Uninstalled plugin`);
    //         } else {
    //             console.log(
    //                 "Failed to update Code Time about the uninstall event"
    //             );
    //         }
    //     }
    // });
}

export async function activate(ctx: ExtensionContext) {
    // add the code time commands
    ctx.subscriptions.push(createCommands(kpmController));

    // onboard the user as anonymous if it's being installed
    if (window.state.focused) {
        onboardInit(ctx, intializePlugin /*successFunction*/);
    } else {
        // 8 to 15 second delay
        const secondDelay = getRandomArbitrary(8, 15);
        // initialize in 5 seconds if this is the secondary window
        setTimeout(() => {
            onboardInit(ctx, intializePlugin /*successFunction*/);
        }, 1000 * secondDelay);
    }
}

function getRandomArbitrary(min, max) {
    max = max + 0.1;
    return parseInt(Math.random() * (max - min) + min, 10);
}

export async function intializePlugin(
    ctx: ExtensionContext,
    createdAnonUser: boolean
) {
    logIt(`Loaded ${getPluginName()} v${getVersion()}`);
    await tracker.init();

    // store the activate event
    tracker.trackEditorAction("editor", "activate");

    // INIT the plugin data manager
    PluginDataManager.getInstance();

    // initialize the wall clock timer
    WallClockManager.getInstance();

    // load the last payload into memory
    getLastSavedKeystrokesStats();

    // add the interval jobs
    initializeIntervalJobs();

    // get the login status
    // {loggedIn: true|false}
    await isLoggedIn();

    // initialize preferences
    await initializePreferences();

    initializeLiveshare();

    const initializedVscodePlugin = getItem("vscode_CtInit");
    if (!initializedVscodePlugin) {
        setItem("vscode_CtInit", true);

        // send a bootstrap kpm payload
        // kpmController.buildBootstrapKpmPayload();

        // send a heartbeat that the plugin as been installed
        // (or the user has deleted the session.json and restarted the IDE)
        sendHeartbeat("INSTALLED");

        setTimeout(() => {
            commands.executeCommand("codetime.displayTree");
        }, 1200);
    }

    // show the readme if it doesn't exist
    displayReadmeIfNotExists();

    // show the status bar text info
    setTimeout(() => {
        statusBarItem = window.createStatusBarItem(
            StatusBarAlignment.Right,
            10
        );
        // add the name to the tooltip if we have it
        const name = getItem("name");
        let tooltip = "Click to see more from Code Time";
        if (name) {
            tooltip = `${tooltip} (${name})`;
        }
        statusBarItem.tooltip = tooltip;
        statusBarItem.command = "codetime.displayTree";
        statusBarItem.show();

        // update the status bar
        updateStatusBarWithSummaryData();
    }, 0);

    // in 15 seconds
    setTimeout(() => {
        commands.executeCommand("codetime.sendOfflineData");
    }, 1000 * 15);
}

// add the interval jobs
function initializeIntervalJobs() {
    hourly_interval = setInterval(async () => {
        sendHeartbeat("HOURLY");
    }, one_hour_millis);

    twenty_minute_interval = setInterval(async () => {
        // this will get the login status if the window is focused
        // and they're currently not a logged in
        if (window.state.focused) {
            const name = getItem("name");
            // but only if checkStatus is true
            if (!name) {
                isLoggedIn();
            }
        }
    }, one_min_millis * 30);

    // update liveshare in the offline kpm data if it has been initiated
    liveshare_update_interval = setInterval(async () => {
        if (window.state.focused) {
            updateLiveshareTime();
        }
    }, one_min_millis);

    // every 15 minutes
    // PLUGIN DATA TIMER
    fifteen_minute_interval = setInterval(() => {
        commands.executeCommand("codetime.sendOfflineData");
    }, one_min_millis * 15);
}

function handlePauseMetricsEvent() {
    TELEMETRY_ON = false;
    showStatus("Code Time Paused", "Enable metrics to resume");
}

function handleEnableMetricsEvent() {
    TELEMETRY_ON = true;
    showStatus("Code Time", null);
}

function updateLiveshareTime() {
    if (_ls) {
        let nowSec = nowInSecs();
        let diffSeconds = nowSec - parseInt(_ls["start"], 10);
        setSessionSummaryLiveshareMinutes(diffSeconds * 60);
    }
}

async function initializeLiveshare() {
    const liveshare = await getApi();
    if (liveshare) {
        // {access: number, id: string, peerNumber: number, role: number, user: json}
        logIt(`liveshare version - ${liveshare["apiVersion"]}`);
        liveshare.onDidChangeSession(async (event) => {
            let nowSec = nowInSecs();
            let offsetSec = getOffsetSeconds();
            let localNow = nowSec - offsetSec;
            if (!_ls) {
                _ls = {
                    ...event.session,
                };
                _ls["apiVesion"] = liveshare["apiVersion"];
                _ls["start"] = nowSec;
                _ls["local_start"] = localNow;
                _ls["end"] = 0;

                await manageLiveshareSession(_ls);
            } else if (_ls && (!event || !event["id"])) {
                updateLiveshareTime();
                // close the session on our end
                _ls["end"] = nowSec;
                _ls["local_end"] = localNow;
                await manageLiveshareSession(_ls);
                _ls = null;
            }
        });
    }
}
