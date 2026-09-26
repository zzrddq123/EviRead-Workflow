import argparse,json
from pathlib import Path
import numpy as np
p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--query',required=True);p.add_argument('--donor',required=True);p.add_argument('--refs',required=True);p.add_argument('--output',required=True);p.add_argument('--k',type=int,default=20);a=p.parse_args()
q=np.load(a.query,mmap_mode='r');d=np.load(a.donor,mmap_mode='r'); refs=json.loads(Path(a.refs).read_text()); out=[]
for i in range(len(q)):
 s=np.asarray(d@q[i],dtype=np.float32);ix=np.argpartition(s,-a.k)[-a.k:];ix=ix[np.argsort(s[ix])[::-1]];out.append([{'reference_index':int(j),'id':refs[int(j)]['id'],'cosine':float(s[j])} for j in ix])
 if i%100==0: print(a.model,i,flush=True)
json.dump({'model':a.model,'query_count':len(q),'neighbors':out},open(a.output,'w'));print('done')
