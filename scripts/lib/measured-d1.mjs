// Local diagnostics only. No environment credentials or remote database access.
export function measuredD1(db) {
  const samples=[];
  const record=result=>{samples.push(result.meta??{});return result;};
  const wrap=statement=>({statement,
    bind(...args){return wrap(statement.bind(...args));},
    async all(){trips++;return record(await statement.all());},
    async first(column){const row=(await this.all()).results[0]??null;return column?row?.[column]??null:row;},
    async run(){trips++;return record(await statement.run());}
  });
  let trips=0;
  return {samples,
    db:{prepare(sql){return wrap(db.prepare(sql));},
      async batch(statements){trips++;return (await db.batch(statements.map(s=>s.statement))).map(record);}},
    totals(){return {statements:samples.length,trips,rows_read:samples.reduce((n,m)=>n+(m.rows_read??0),0),rows_written:samples.reduce((n,m)=>n+(m.rows_written??0),0)};}
  };
}
