cd /tmp/claude-501
chey second-opinion --preset staff-engineer --author-model claude-opus-5-5 --title "JamSesh Phase 3: the big screen" --diff jamsesh/phase-2...jamsesh/phase-3 --repo "$HOME/jamsesh-p3" --context @/tmp/claude-501/p3-context.md \
 --focus "Questions and consent: does Session.openQuestionsFor cover every yes/no a person can be asked (builds, show requests, lock questions, anything else), and can one spoken answer settle more than one, or settle one when several are open?" \
 --focus "Stage writes: setStage now requires a person, override or StageClaim. Can any delayed or async path still write without a claim, or with one taken too late, and is override used anywhere it shouldn't be? Are ended shares always kept off?" \
 --focus "Screen names: ids only as ids, names only when unique, unique whole-word starts. Any way to reach the wrong screen?" \
 --focus "App: Reopen checks unsaved before stopping, Reopen anyway clears it only in a valid turn; screens_save and the user-less toggle take their quiet turn first. Anything still acting on the wrong session or restarting over a failed save?" \
 --focus "Confirm each finding in /tmp/claude-501/p3-review7.md is fixed" --focus "Are the tests meaningful, and what should be deleted?" > /tmp/claude-501/p3-review8.log 2>&1
echo "exit $?" >> /tmp/claude-501/p3-review8.log
