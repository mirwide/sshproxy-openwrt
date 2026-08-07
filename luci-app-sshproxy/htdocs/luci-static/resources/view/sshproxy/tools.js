'use strict';
'require baseclass';
'require fs';
'require rpc';
'require ui';
'require uci';

document.head.append(E('style', {'type': 'text/css'},
`
.label-status {
    display: inline;
    margin: 0 2px 0 0 !important;
    padding: 2px 4px;
    -webkit-border-radius: 3px;
    -moz-border-radius: 3px;
    border-radius: 3px;
    font-weight: bold;
    color: #fff !important;
}
.running {
    background-color: #2ea256 !important;
}
.starting {
    background-color: #9c994c !important;
}
.stopped {
    background-color: #8a8a8a !important;
}
.error {
    background-color: #ff4e54 !important;
}
`));

return baseclass.extend({
    appName: 'sshproxy',

    infoLabelRunning  : '<span class="label-status running">'  + _('Running')  + '</span>',
    infoLabelStarting : '<span class="label-status starting">' + _('Starting') + '</span>',
    infoLabelStopped  : '<span class="label-status stopped">'  + _('Stopped')  + '</span>',
    infoLabelDisabled : '<span class="label-status stopped">'  + _('Disabled') + '</span>',
    infoLabelError    : '<span class="label-status error">'    + _('Error')    + '</span>',

    statusDict: {
        error    : { code: 0, name: _('Error')    , label: this.infoLabelError    },
        disabled : { code: 1, name: _('Disabled') , label: this.infoLabelDisabled },
        stopped  : { code: 2, name: _('Stopped')  , label: this.infoLabelStopped  },
        starting : { code: 3, name: _('Starting') , label: this.infoLabelStarting },
        running  : { code: 4, name: _('Running')  , label: this.infoLabelRunning  },
    },

    callServiceList: rpc.declare({
        object: 'service',
        method: 'list',
        params: [ 'name', 'verbose' ],
        expect: { '': {} }
    }),

    callInitState: rpc.declare({
        object: 'luci',
        method: 'getInitList',
        params: [ 'name' ],
        expect: { '': {} }
    }),

    callInitAction: rpc.declare({
        object: 'luci',
        method: 'setInitAction',
        params: [ 'name', 'action' ],
        expect: { result: false }
    }),

    getSvcInfo: function()
    {
        return this.callServiceList(this.appName, 1).then(res => {
            return res;
        }).catch(e => {
            ui.addNotification(null, E('p', _('Failed to get %s service info: %s').format(this.appName, e.message)));
        });
    },

    getInitState: function()
    {
        return this.callInitState(this.appName).then(res => {
            if (res && res[this.appName]) {
                return res[this.appName].enabled ? true : false;
            }
            throw _('Command failed');
        }).catch(e => {
            ui.addNotification(null, E('p', _('Failed to get %s init status: %s').format(this.appName, e.message)));
        });
    },

    handleServiceAction: function(action)
    {
        return this.callInitAction(this.appName, action).then(success => {
            if (!success) {
                throw _('Command failed');
            }
            return true;
        }).catch(e => {
            let msg = (typeof(e) == 'object' && e.message) ? e.message : '' + e;
            if (msg != 'XHR request aborted by browser') {
                ui.addNotification(null, E('p', _('Service action "%s %s" failed: %s').format(this.appName, action, msg)));
            }
            throw e;
        });
    },

    serviceActionEx: async function(action)
    {
        try {
            await this.handleServiceAction(action);
        } catch(e) { }
    },

    promiseAllDict: function(promisesDict)
    {
        const keys = Object.keys(promisesDict);
        const promises = keys.map(key => promisesDict[key]);
        return Promise.all(promises)
            .then(results => {
                const resultDict = { };
                keys.forEach((key, index) => {
                    resultDict[key] = results[index];
                });
                return resultDict;
            });
    },

    baseLoad: function(ctx, callback)
    {
        return Promise.all([
            this.getSvcInfo(),
            uci.load(this.appName),
        ])
        .then( ([ svcInfo, uci_data ]) => {
            let ret = { svc_info: svcInfo, uci_data };
            if (typeof(callback) === 'function') {
                const res = callback.call(ctx, ret);
                if (res && typeof(res.then) === 'function') {
                    return res.then(() => res);
                }
                return ret;
            }
            return ret;
        })
        .catch(e => {
            ui.addNotification(null, E('p', _('Unable to read the contents') + ' (baseLoad): %s'.format(e.message)));
            return null;
        });
    },

    get_pid_list: function(proc_list) {
        let plist = [ ];
        let lines = proc_list.trim().split('\n');
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line.length > 5) {
                let word_list = line.split(/\s+/);
                let pid = word_list[0];
                let isnum = /^\d+$/.test(pid);
                if (isnum) {
                    plist.push(parseInt(pid));
                }
            }
        }
        return plist;
    },

    decode_svc_info: function(svc_autorun, svc_info, proc_list, cfg = null)
    {
        let result = {
            "autorun": svc_autorun,
            "dmn": {
                inited: false,
                total: 0,
                running: 0,
                working: 0,
            },
            "status": this.statusDict.error,
        };
        let plist = proc_list;
        if (proc_list?.code !== undefined) {
            if (proc_list.code != 0) {
                return -2;
            }
            plist = this.get_pid_list(proc_list.stdout);
            if (plist.length < 4) {
                return -3;
            }
        }
        if (svc_info == null || typeof(svc_info) !== 'object') {
            return null;
        }
        let jdata = svc_info;
        if (typeof(jdata[this.appName]) == 'object') {
            result.dmn.inited = true;
            let dmn_list = jdata[this.appName].instances;
            if (typeof(dmn_list) == 'object') {
                for (const [dmn_name, daemon] of Object.entries(dmn_list)) {
                    result.dmn.total += 1;
                    if (daemon.running) {
                        result.dmn.running += 1;
                    }
                    if (daemon.pid !== undefined && daemon.pid != null) {
                        if (plist.includes(daemon.pid)) {
                            result.dmn.working += 1;
                        }
                    }
                }
            }
        }
        if (result.dmn.total == 0) {
            result.status = (!svc_autorun) ? this.statusDict.disabled : this.statusDict.stopped;
        } else {
            result.status = this.statusDict.running;
        }
        return result;
    },

    makeStatusString: function(svcinfo) {
        let svc_autorun = _('Unknown');
        let svc_daemons = _('Unknown');

        if (typeof(svcinfo) == 'object' && svcinfo?.autorun !== undefined) {
            svc_autorun = (svcinfo.autorun) ? _('Enabled') : _('Disabled');
            if (!svcinfo.dmn.inited) {
                svc_daemons = _('Stopped');
            } else {
                svc_daemons = (!svcinfo.dmn.working) ? _('Starting') : _('Running');
                svc_daemons += ' [' + svcinfo.dmn.working + '/' + svcinfo.dmn.total + ']';
            }
        }
        let td_name_width = 40;
        let td_name_style = `style="width: ${td_name_width}%; min-width:${td_name_width}%; max-width:${td_name_width}%;"`;
        let out = `
                <table class="table">
                    <tr class="tr">
                        <td class="td left" ${td_name_style}>
                            ${_('Service autorun status')}:
                        </td>
                        <td class="td left">
                            ${svc_autorun}
                        </td>
                    </tr>
                    <tr class="tr">
                        <td class="td left" ${td_name_style}>
                            ${_('Service daemons status')}:
                        </td>
                        <td class="td left">
                            ${svc_daemons}
                        </td>
                    </tr>
                </table>`;
        return out;
    },

    getLineCount: function(mstr) {
        let count = 0;
        let c = '\n'.charAt(0);
        for (let i = 0; i < mstr.length; ++i) {
            if (c === mstr.charAt(i)) {
                ++count;
            }
        }
        return count;
    },

    POLLER: baseclass.extend({
        __init__: function(opts = { })
        {
            Object.assign(this, {
                interval: 1000,
                func: null,
                active: false,
                running: false,
            }, opts);
            this.ticks = 0;
            this.timer = null;
            this.mode = 0;
        },

        init: function(func, interval = null)
        {
            this.func = func;
            if (interval) {
                this.interval = interval;
            }
        },

        start: function(delay = 0)
        {
            if (this.active) {
                return;
            }
            this.ticks = 0;
            this.active = true;
            if (delay === null) {
                this.step();
                delay = this.interval;
            }
            this.timer = window.setTimeout(this.step.bind(this), delay);
            return true;
        },

        stop: function()
        {
            this.active = false;
            if (this.timer) {
                window.clearTimeout(this.timer);
                this.timer = null;
            }
        },

        step: function()
        {
            if (!this.active) {
                return;
            }
            if (this.timer) {
                window.clearTimeout(this.timer);
            }
            if (this.mode == 1 && this.running) {
                this.timer = window.setTimeout(this.step.bind(this), 100);
                return;
            }
            this.ticks += 1;
            this.running = true;
            Promise.resolve(this.func()).finally((function() {
                if (this.mode == 0) {
                    this.running = false;
                }
                this.timer = null;
                if (this.active) {
                    this.timer = window.setTimeout(this.step.bind(this), this.interval);
                }
            }).bind(this));
        },

        stopAndWait: async function(interval = 50)
        {
            this.stop();
            if (!this.running) {
                return;
            }
            return new Promise((resolve) => {
                const timer = setInterval(() => {
                    if (!this.running) {
                        clearInterval(timer);
                        resolve();
                    }
                }, interval);
            });
        },
    }),

    // adapted from luci-base htdocs/luci-static/resources/ui.js
    createHandlerFnEx: function(ctx, fn, opts = { }, ...args)
    {
        if (typeof(fn) === 'string') {
            fn = ctx[fn];
        }
        if (typeof(fn) !== 'function') {
            return null;
        }
        const {
            callback = null,
            keepDisabled = false,
            noSpin = false
        } = opts;
        return L.bind(function() {
            const btn = arguments[args.length].currentTarget;
            if (!noSpin) {
                btn.classList.add('spinning');
            }
            btn.disabled = true;
            if (btn.blur) btn.blur();
            let result, error;
            return Promise
                .resolve()
                .then(() => fn.apply(ctx, arguments))
                .then(r => { result = r; })
                .catch(e => { error = e; })
                .finally(() => {
                    if (!noSpin) {
                        btn.classList.remove('spinning');
                    }
                    if (!keepDisabled) {
                        btn.disabled = false;
                    }
                    if (typeof(callback) === 'function') {
                        callback.call(ctx, btn, result, error);
                    }
                    if (error) {
                        throw error;
                    }
                });
        }, ctx, ...args);
    },
});
