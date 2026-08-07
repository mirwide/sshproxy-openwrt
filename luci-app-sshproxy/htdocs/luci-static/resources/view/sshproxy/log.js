'use strict';
'require fs';
'require ui';
'require view';
'require view.sshproxy.tools as tools';

// Прокси логирует в syslog (procd направляет stdout/stderr туда),
// поэтому журнал читается через logread с фильтром по имени сервиса.

return view.extend({
    POLL: new tools.POLLER( { } ),

    retrieveLog: async function()
    {
        return tools.promiseAllDict({
            log_data: L.resolveDefault(fs.exec('/sbin/logread', [ '-e', tools.appName ]), null),
        }).then((data) => {
            if (!data.log_data || data.log_data.code != 0) {
                return '';
            }
            return data.log_data.stdout || '';
        }).catch(e => {
            ui.addNotification(null, E('p', _('Unable to read the log')
                + ': %s'.format(e.message)));
            return '';
        }).finally(() => {
            this.POLL.running = false;
        });
    },

    pollLog: async function()
    {
        let logdata = await this.retrieveLog();
        let elem = document.getElementById('dmnlog_0');
        if (!elem) {
            return;
        }
        elem.value = logdata;
        elem.rows = tools.getLineCount(logdata) + 1;
        if (this.stick_tail) {
            elem.scrollTop = elem.scrollHeight;
        }
    },

    load: function()
    {
        return this.retrieveLog();
    },

    render: function(logdata)
    {
        if (logdata == null) {
            ui.addNotification(null, E('p', _('Unable to get log data') + ': render()'));
            return;
        }

        let scrollDownButton = E('button', {
            'id': 'scrollDownButton_0',
            'class': 'cbi-button cbi-button-neutral'
        }, _('Scroll to tail'));
        let scrollUpButton = E('button', {
            'id': 'scrollUpButton_0',
            'class': 'cbi-button cbi-button-neutral'
        }, _('Scroll to head'));
        scrollDownButton.addEventListener('click', function() {
            this.stick_tail = true;
            let el = document.getElementById('dmnlog_0');
            if (el) {
                el.scrollTop = el.scrollHeight;
            }
        }.bind(this));
        scrollUpButton.addEventListener('click', function() {
            this.stick_tail = false;
            let el = document.getElementById('dmnlog_0');
            if (el) {
                el.scrollTop = 0;
            }
        }.bind(this));

        let log_text = (logdata) ? logdata : '';
        let textarea = E('textarea', {
            'id': 'dmnlog_0',
            'name': 'log',
            'style': 'font-size:12px; width: 100%; max-height: 60vh;',
            'readonly': 'readonly',
            'wrap': 'off',
            'rows': tools.getLineCount(log_text) + 1,
        }, [ log_text ]);

        this.POLL.mode = 1;
        this.POLL.init( this.pollLog.bind(this), 2000 );
        this.POLL.start();

        return E('div', { }, [
            E('div', { 'class': 'cbi-title-section' }, [
                E('h2', { 'class': 'cbi-title-field' }, 'SSHProxy - ' + _('Log Viewer')),
            ]),
            E('div', { 'class': 'cbi-section fade-in' }, [
                E('div', { 'class': 'cbi-value-description' },
                    _('Syslog entries filtered by "sshproxy".')),
                E('div', { 'style': 'margin-bottom: 20px; ' }, [ scrollDownButton ]),
                textarea,
                E('div', { 'style': 'margin-top: 20px' }, [ scrollUpButton ]),
            ]),
        ]);
    },

    handleSaveApply: null,
    handleSave: null,
    handleReset: null
});
