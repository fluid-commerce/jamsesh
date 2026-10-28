import json,urllib.request,os,subprocess,time
def get(u):
    for i in range(12):
        try: return urllib.request.urlopen(u,timeout=60).read()
        except Exception as e:
            time.sleep(3+i*3)
    raise SystemExit('fail '+u)
spk={'84':462,'1272':1174,'174':1247,'1462':1664,'251':1758,'2277':0}
meta=[]
for s,off in spk.items():
    d=json.loads(get(f"https://datasets-server.huggingface.co/rows?dataset=openslr/librispeech_asr&config=clean&split=validation&offset={off}&length=30"))
    n=0
    for r in d['rows']:
        row=r['row']; p=f"/tmp/jam-audio/raw/{row['id']}.wav"
        open(p+'.dl','wb').write(get(row['audio'][0]['src']))
        subprocess.run(['/opt/homebrew/bin/ffmpeg','-y','-loglevel','error','-i',p+'.dl','-ar','16000','-ac','1','-c:a','pcm_s16le',p],check=True)
        os.remove(p+'.dl')
        dur=(os.path.getsize(p)-44)/32000
        if 3.5<=dur<=11:
            meta.append({'id':row['id'],'speaker':s,'text':row['text'],'dur':dur,'file':p}); n+=1
        else: os.remove(p)
        time.sleep(0.4)
        if n>=10: break
json.dump(meta,open('/tmp/jam-audio/meta.json','w'),indent=1)
from collections import Counter;print(Counter(m['speaker'] for m in meta))
