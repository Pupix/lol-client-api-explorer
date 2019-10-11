const electron = require('electron');
const LCUConnector = require('lcu-connector');
const DiscordRPC = require('discord-rpc');
const request = require('request-promise');
const {
    duplicateSystemYaml,
    restartLCUWithOverride,
    getOverrideFilePath,
} = require('./util');

const connector = new LCUConnector();
const { app, dialog } = electron;
const { BrowserWindow } = electron;

const root = `${__dirname}/app`;

// Checking if the running executable is called electron
// seems to be the most straightforward to do this
// https://stackoverflow.com/a/39395885/4895858
const isDev = process.execPath.search('electron') !== -1;

const clientId = '616399159322214425';
const rpc = new DiscordRPC.Client({ transport: 'ipc' });
const startTimestamp = new Date();

app.commandLine.appendSwitch('--ignore-certificate-errors');

app.on('ready', () => {
    let mainWindow = null;
    let windowLoaded = false;
    let LCUData = null;

    mainWindow = new BrowserWindow({
        center: true,
        height: 720,
        show: false,
        width: 1280,
        title: 'Rift Explorer',
        backgroundColor: '#303030',
        webPreferences: {
            nodeIntegration: true,
        },
    });

    if (isDev) {
        mainWindow.openDevTools();
    }

    // Remove default menu
    mainWindow.setMenu(null);
    mainWindow.loadURL(`file://${root}/index.html`);

    // Avoid white page on load.
    mainWindow.webContents.on('did-finish-load', () => {
        windowLoaded = true;

        mainWindow.show();

        if (!LCUData) {
            return;
        }

        mainWindow.webContents.send('lcu-load', LCUData);
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    async function f(data, auth) {
        try {
            request.get({
                url: `https://127.0.0.1:${data.port}/data-store/v1/install-dir`,
                strictSSL: false,
                headers: {
                    Authorization: `Basic ${auth}`,
                },
            }).then(() => {
                mainWindow.webContents.send('lcu-load', data);
            }).catch(() => {
                throw new Error('API not ready');
            });
        } catch (e) {
            console.log('API isn\'t ready yet giving it more time...');
            setTimeout(() => {
                f();
            }, 2500);
        }
    }

    async function checkArgs(data, auth) {
        try {
            request.get({
                url: `https://127.0.0.1:${data.port}/riotclient/command-line-args`,
                strictSSL: false,
                headers: {
                    Authorization: `Basic ${auth}`,
                },
            }).then(async (cmdlineargs) => {
                const arr = JSON.parse(cmdlineargs);
                if (arr.includes(`--system-yaml-override=${await getOverrideFilePath()}`)) {
                    mainWindow.webContents.send('lcu-load', data);
                } else {
                    await duplicateSystemYaml();
                    const response = dialog.showMessageBoxSync({
                        type: 'info',
                        buttons: ['Cancel', 'Ok'],
                        title: 'Rift Explorer',
                        message: 'Rift Explorer needs to restart your League of Legends client to work properly',
                        cancelId: 0,
                        noLink: true,
                    });

                    if (!response) {
                        mainWindow.close();
                        return;
                    }
                    await restartLCUWithOverride(data)
                        .then(async () => {
                            await f(data, auth);
                        });
                }
            }).catch();
        } catch (e) {
            console.log('API isn\'t ready yet giving it more time...');
            setTimeout(() => {
                checkArgs(data, auth);
            }, 2500);
        }
    }

    connector.on('connect', (data) => {
        const auth = Buffer.from(`${data.username}:${data.password}`)
            .toString('base64');
        checkArgs(data, auth);
    });

    connector.on('disconnect', () => {
        LCUData = null;

        if (windowLoaded) {
            mainWindow.webContents.send('lcu-unload');
        }
    });

    async function setActivity() {
        if (!rpc || !mainWindow) {
            return;
        }

        rpc.setActivity({
            startTimestamp,
            largeImageKey: 'rift',
            largeImageText: 'Rift Explorer',
            instance: false,
        })
            .catch(console.error);
    }

    rpc.on('ready', () => {
        setActivity()
            .catch(console.error);

        // activity can only be set every 15 seconds
        setInterval(() => {
            setActivity()
                .catch(console.error);
        }, 15e3);
    });

    rpc.on('error', console.error);

    connector.start();
    rpc.login({ clientId })
        .catch(console.error);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        rpc.destroy()
            .catch(console.error);
        app.quit();
    }
});
