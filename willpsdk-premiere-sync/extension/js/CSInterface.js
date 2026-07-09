// Cut-down CSInterface — just the bits this panel uses: evalScript, host
// environment, system paths and CEP events. Same API as Adobe's version.

function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
    if (callback === null || callback === undefined) {
        callback = function () {};
    }
    window.__adobe_cep__.evalScript(script, callback);
};

CSInterface.prototype.getHostEnvironment = function () {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
};

CSInterface.prototype.getSystemPath = function (pathType) {
    var path = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
    var OSVersion = this.getOSInformation();
    if (OSVersion.indexOf('Windows') >= 0) {
        path = path.replace('file:///', '');
    } else {
        path = path.replace('file://', '');
    }
    return path;
};

CSInterface.prototype.getOSInformation = function () {
    var userAgent = navigator.userAgent;
    if (navigator.platform === 'Win32' || navigator.platform === 'Windows') {
        return 'Windows';
    }
    return 'Mac';
};

CSInterface.prototype.addEventListener = function (type, listener, obj) {
    window.__adobe_cep__.addEventListener(type, listener, obj);
};

CSInterface.SystemPath = {
    USER_DATA: 'userData',
    EXTENSION: 'extension',
    MY_DOCUMENTS: 'myDocuments'
};
