'use strict';
'require fs';
'require uci';
'require ui';
'require view';
'require view.sshproxy.tools as tools';

const btn_style_action   = 'btn cbi-button-action';
const btn_style_positive = 'btn cbi-button-save important';
const btn_style_negative = 'btn cbi-button-reset important';

return view.extend({
    POLL: new tools.POLLER( { } ),

    get_svc_buttons: function(elems = { }) {
        return {
            "enable"  : elems.btn_enable  || document.getElementById('btn_enable'),
            "disable" : elems.btn_disable || document.getElementById('btn_disable'),
            "start"   : elems.btn_start   || document.getElementById('btn_start'),
            "restart" : elems.btn_restart || document.getElementById('btn_restart'),
            "stop"    : elems.btn_stop    || document.getElementById('btn_stop'),
        };
    },

    disableButtons: function(flag, elems = { }) {
        let btn = this.get_svc_buttons(elems);
        btn.enable.disabled  = flag;
        btn.disable.disabled = flag;
        btn.start.disabled   = flag;
        btn.restart.disabled = flag;
        btn.stop.disabled    = flag;
    },

    getAppStatus: function()
    {
        return tools.promiseAllDict({
            svc_boot   : tools.getInitState(),
            svc_info   : tools.getSvcInfo(),
            proc_list  : fs.exec('/bin/busybox', [ 'ps' ]),
            uci_data   : uci.load(tools.appName),
        }).catch(e => {
            ui.addNotification(null, E('p', _('Unable to execute or read contents')
                + ': %s [ %s | %s | %s ]'.format(
                    e.message, 'tools.getInitState', 'tools.getSvcInfo', 'uci.' + tools.appName
            )));
        });
    },

    setAppStatus: function(data, elems = { })
    {
        let cfg = uci.get(tools.appName, 'sshproxy');
        if (!data || cfg == null || typeof(cfg) !== 'object') {
            let elem_status = elems.status || document.getElementById("status");
            elem_status.innerHTML = tools.makeStatusString(null);
            ui.addNotification(null, E('p', _('Unable to read the contents') + ': setAppStatus()'));
            this.disableButtons(true, elems);
            return;
        }
        let svc_boot = data.svc_boot ? true : false;
        let svcinfo = tools.decode_svc_info(svc_boot, data.svc_info, data.proc_list, cfg);
        let btn = this.get_svc_buttons(elems);

        if (svcinfo == null || Number.isInteger(svcinfo)) {
            ui.addNotification(null, E('p', _('Error') + ': decode_svc_info()'));
            this.disableButtons(true, elems);
        } else {
            btn.enable.disabled  = (svc_boot) ? true : false;
            btn.disable.disabled = (svc_boot) ? false : true;
            if (!svcinfo.dmn.inited) {
                btn.start.disabled   = false;
                btn.restart.disabled = true;
                btn.stop.disabled    = true;
            } else {
                btn.start.disabled   = true;
                btn.restart.disabled = false;
                btn.stop.disabled    = false;
            }
        }
        let elem_status = elems.status || document.getElementById("status");
        elem_status.innerHTML = tools.makeStatusString(svcinfo);
        this.POLL.running = false;
    },

    serviceActionEx: async function(action, button, args = [ ])
    {
        await this.POLL.stopAndWait();
        this.disableButtons(true);
        try {
            await tools.serviceActionEx(action);
        } catch(e) { }
    },

    serviceActionExCallback: function(btn, result, error)
    {
        this.POLL.start(150);
    },

    createServiceHandlerFn: function(action, btn_name)
    {
        let opt = { keepDisabled: true, callback: this.serviceActionExCallback };
        return tools.createHandlerFnEx(this, 'serviceActionEx', opt, action, btn_name);
    },

    statusPoll: function()
    {
        this.getAppStatus().then(
            L.bind(this.setAppStatus, this)
        );
    },

    load: function()
    {
        return tools.baseLoad(this, (data) => {
            return this.getAppStatus();
        });
    },

    render: function(data)
    {
        if (!data) {
            return;
        }

        let status_string = E('div', {
            'id'   : 'status',
            'name' : 'status',
            'class': 'cbi-section-node',
        });

        let layout = E('div', { 'class': 'cbi-section-node' });

        function layout_append(title, elems) {
            let elem_list = [ ];
            for (let i = 0; i < elems.length; i++) {
                elem_list.push(elems[i]);
                elem_list.push(' ');
            }
            layout.append(
                E('div', { 'class': 'cbi-value' }, [
                    E('label', { 'class': 'cbi-value-title' }, title),
                    E('div', { 'class': 'cbi-value-field' }, [ E('div', {}, elem_list) ]),
                ])
            );
        }

        let create_btn = function(name, _class, locname) {
            return E('button', {
                'id'   : name,
                'name' : name,
                'class': _class,
            }, locname);
        };

        let btn_enable      = create_btn('btn_enable',  btn_style_positive, _('Enable'));
        btn_enable.onclick  = this.createServiceHandlerFn('enable', 'btn_enable');
        let btn_disable     = create_btn('btn_disable', btn_style_negative, _('Disable'));
        btn_disable.onclick = this.createServiceHandlerFn('disable', 'btn_disable');
        layout_append(_('Service autorun control'), [ btn_enable, btn_disable ] );

        let btn_start       = create_btn('btn_start',   btn_style_action, _('Start'));
        btn_start.onclick   = this.createServiceHandlerFn('start', 'btn_start');
        let btn_restart     = create_btn('btn_restart', btn_style_action, _('Restart'));
        btn_restart.onclick = this.createServiceHandlerFn('restart', 'btn_restart');
        let btn_stop        = create_btn('btn_stop',    btn_style_negative, _('Stop'));
        btn_stop.onclick    = this.createServiceHandlerFn('stop', 'btn_stop');
        layout_append(_('Service daemons control'), [ btn_start, btn_restart, btn_stop ] );

        let elems = {
            "status": status_string,
            "btn_enable": btn_enable,
            "btn_disable": btn_disable,
            "btn_start": btn_start,
            "btn_restart": btn_restart,
            "btn_stop": btn_stop,
        };
        this.setAppStatus(data, elems);

        this.POLL.mode = 1;
        this.POLL.init( L.bind(this.statusPoll, this), 2000 );
        this.POLL.start(500);

        return E([
            E('h2', { 'class': 'fade-in' }, 'SSHProxy'),
            E('div', { 'class': 'cbi-section-descr fade-in' },
                _('Transparent SSH proxy: netfilter rules redirect traffic to the listed subnets into an SSH tunnel.')),
            E('div', { 'class': 'cbi-section fade-in' }, [
                status_string,
            ]),
            E('div', { 'class': 'cbi-section fade-in' },
                layout
            ),
        ]);
    },

    handleSave     : null,
    handleSaveApply: null,
    handleReset    : null,
});
